import { extractIssueKey, type IngestEvent } from "@devpulse/shared";

/**
 * Pure event construction for the git hooks. All git/OS access is done by the
 * agent and passed in as plain facts, so the mapping from "what git told us" to
 * "the event we send" is unit-testable and the privacy rule is easy to audit:
 * only the fields below ever leave the machine — never file paths, diffs, or
 * commit message bodies (spec §2).
 */

export type HookName = "post-commit" | "post-checkout" | "pre-push";

export interface HookContext {
  hook: HookName;
  repo?: string | null;
  branch?: string | null;
  // commit
  sha?: string | null;
  shortstat?: string | null;
  aiCoAuthor?: string | null;
  // branch_switch (post-checkout args: prevHead, newHead, flag)
  fromBranch?: string | null;
  toBranch?: string | null;
  checkoutFlag?: string | null;
  // push
  remote?: string | null;
  commitCount?: number | null;
}

export interface DiffStat {
  files_changed?: number;
  insertions?: number;
  deletions?: number;
}

/**
 * Parse the single line emitted by `git diff --shortstat`, e.g.
 * ` 3 files changed, 42 insertions(+), 7 deletions(-)`. Missing clauses (a
 * commit with only insertions, say) simply omit that key.
 */
export function parseShortstat(text: string | null | undefined): DiffStat {
  const stat: DiffStat = {};
  if (!text) return stat;
  const files = text.match(/(\d+)\s+files?\s+changed/);
  const ins = text.match(/(\d+)\s+insertions?\(\+\)/);
  const del = text.match(/(\d+)\s+deletions?\(-\)/);
  if (files) stat.files_changed = Number(files[1]);
  if (ins) stat.insertions = Number(ins[1]);
  if (del) stat.deletions = Number(del[1]);
  return stat;
}

// Known AI co-author trailer signatures (spec §4.2 AI flag). We record only the
// matched trailer VALUE, never the commit message body.
const AI_COAUTHOR_PATTERNS = [
  /claude/i,
  /gpt/i,
  /copilot/i,
  /cursor/i,
  /codex/i,
  /gemini/i,
];

/** Return the first `Co-authored-by:` trailer that looks like an AI, else null. */
export function detectAiCoAuthor(message: string | null | undefined): string | null {
  if (!message) return null;
  for (const line of message.split(/\r?\n/)) {
    const m = /^\s*co-authored-by:\s*(.+)$/i.exec(line);
    if (!m) continue;
    const value = m[1]!.trim();
    if (AI_COAUTHOR_PATTERNS.some((p) => p.test(value))) return value;
  }
  return null;
}

/**
 * Build the ingestion event for a hook invocation, or null when there is
 * nothing meaningful to report (e.g. a file-level `post-checkout`, or a
 * "branch switch" that did not actually change branch).
 */
export function buildEvent(
  ctx: HookContext,
  opts: { uuid: string; ts: string },
): IngestEvent | null {
  const repo = ctx.repo ?? undefined;
  const branch = ctx.branch ?? undefined;
  const issueKey = extractIssueKey(ctx.branch, null) ?? undefined;

  const base = {
    event_uuid: opts.uuid,
    source: "git_hook" as const,
    ts: opts.ts,
    ...(repo ? { repo } : {}),
    ...(branch ? { branch } : {}),
    ...(issueKey ? { issue_key: issueKey } : {}),
  };

  switch (ctx.hook) {
    case "post-commit": {
      const stat = parseShortstat(ctx.shortstat);
      const metadata = {
        ...(ctx.sha ? { sha: ctx.sha } : {}),
        ...stat,
        ...(ctx.aiCoAuthor ? { ai_co_author: ctx.aiCoAuthor } : {}),
      };
      return { ...base, type: "commit", metadata };
    }

    case "post-checkout": {
      // Only branch checkouts (flag "1") interest us, and only when the branch
      // actually changed.
      if (ctx.checkoutFlag !== "1") return null;
      const from = ctx.fromBranch ?? undefined;
      const to = ctx.toBranch ?? branch;
      if (from && to && from === to) return null;
      return {
        ...base,
        type: "branch_switch",
        metadata: {
          ...(from ? { from_branch: from } : {}),
          ...(to ? { to_branch: to } : {}),
        },
      };
    }

    case "pre-push": {
      return {
        ...base,
        type: "push",
        metadata: {
          ...(typeof ctx.commitCount === "number" && ctx.commitCount >= 0
            ? { commit_count: ctx.commitCount }
            : {}),
          ...(ctx.remote ? { remote: ctx.remote } : {}),
        },
      };
    }
  }
}
