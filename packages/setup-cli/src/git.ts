import { execFileSync } from "node:child_process";
import path from "node:path";
import { detectAiCoAuthor, type HookContext, type HookName } from "./event";

/**
 * Git fact collection for the agent. Every call is short, best-effort, and
 * failure-tolerant (returns null) — a hook must never break because a git
 * command hiccuped. Runs in the repo the hook fired in (process.cwd()).
 *
 * PRIVACY: we only ever surface metadata (repo basename, branch, sha, diff
 * COUNTS, an AI co-author trailer). The commit message is read solely to detect
 * that trailer and is never sent or stored (spec §2).
 */

/** Run a git command, returning trimmed stdout or null on any error. */
function gitOut(args: string[]): string | null {
  try {
    const out = execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    });
    const trimmed = out.trim();
    return trimmed === "" ? null : trimmed;
  } catch {
    return null;
  }
}

/** Repo basename only — never the full path (spec §2). */
function repoName(): string | null {
  const top = gitOut(["rev-parse", "--show-toplevel"]);
  return top ? path.basename(top) : null;
}

function currentBranch(): string | null {
  const b = gitOut(["rev-parse", "--abbrev-ref", "HEAD"]);
  return b && b !== "HEAD" ? b : null;
}

export function collectContext(hook: HookName, args: string[]): HookContext {
  const repo = repoName();
  const branch = currentBranch();

  switch (hook) {
    case "post-commit": {
      const sha = gitOut(["rev-parse", "HEAD"]);
      const shortstat =
        gitOut(["diff", "--shortstat", "HEAD~1", "HEAD"]) ??
        gitOut(["show", "--shortstat", "--format=", "HEAD"]);
      const message = gitOut(["log", "-1", "--format=%B", "HEAD"]);
      return {
        hook,
        repo,
        branch,
        sha,
        shortstat,
        aiCoAuthor: detectAiCoAuthor(message),
      };
    }

    case "post-checkout": {
      // git passes: <prev-HEAD> <new-HEAD> <flag: 1=branch, 0=file>
      const checkoutFlag = args[2] ?? null;
      const fromBranch = gitOut(["rev-parse", "--abbrev-ref", "@{-1}"]);
      return {
        hook,
        repo,
        branch,
        checkoutFlag,
        fromBranch: fromBranch && fromBranch !== "HEAD" ? fromBranch : null,
        toBranch: branch,
      };
    }

    case "pre-push": {
      // git passes: <remote-name> <remote-url>
      const remote = args[0] ?? null;
      const countRaw =
        gitOut(["rev-list", "--count", "@{push}..HEAD"]) ??
        gitOut(["rev-list", "--count", "@{u}..HEAD"]);
      const commitCount = countRaw != null ? Number(countRaw) : null;
      return {
        hook,
        repo,
        branch,
        remote,
        commitCount: Number.isFinite(commitCount) ? commitCount : null,
      };
    }
  }
}
