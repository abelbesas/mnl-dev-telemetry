import { execFile } from "node:child_process";
import path from "node:path";
import * as vscode from "vscode";
import type { RepoContext } from "./lib/presentation";

/**
 * Which repo/branch is the user looking at, and tell me when it changes.
 *
 * Primary source is the built-in `vscode.git` extension's API: it already
 * watches `.git/HEAD` for every open repository and exposes state changes as
 * events, so we get branch-switch updates without polling or a file watcher
 * (brief §4). If that extension is missing or disabled (some Cursor/remote
 * setups, `git.enabled: false`), we fall back to one short `git rev-parse` per
 * refresh — correct, just event-poorer.
 *
 * PRIVACY (spec §2): only the repo directory *basename* and branch name are
 * surfaced; the absolute path never leaves this module.
 */

// --- Minimal shape of the vscode.git API we consume (extensions/git/src/api/git.d.ts).
// Declared locally rather than vendored so we depend on nothing at build time.

interface GitBranch {
  readonly name?: string;
}

interface GitRepositoryState {
  readonly HEAD: GitBranch | undefined;
  readonly onDidChange: vscode.Event<void>;
}

interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: GitRepositoryState;
}

interface GitAPI {
  readonly state: "uninitialized" | "initialized";
  readonly onDidChangeState: vscode.Event<"uninitialized" | "initialized">;
  readonly repositories: GitRepository[];
  readonly onDidOpenRepository: vscode.Event<GitRepository>;
  readonly onDidCloseRepository: vscode.Event<GitRepository>;
  getRepository(uri: vscode.Uri): GitRepository | null;
}

interface GitExtension {
  readonly enabled: boolean;
  readonly onDidChangeEnablement: vscode.Event<boolean>;
  getAPI(version: 1): GitAPI;
}

// --- git CLI fallback ------------------------------------------------------

function gitOut(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, timeout: 2000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        const trimmed = stdout.trim();
        resolve(trimmed === "" ? null : trimmed);
      },
    );
  });
}

async function repoContextViaCli(cwd: string): Promise<RepoContext | null> {
  const top = await gitOut(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top) return null;

  // `rev-parse --abbrev-ref` says "HEAD" when detached and fails outright on an
  // unborn branch (a freshly `git init`ed repo). `symbolic-ref` answers both:
  // it names the branch before the first commit and fails when detached.
  const revParse = await gitOut(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch =
    revParse && revParse !== "HEAD"
      ? revParse
      : await gitOut(cwd, ["symbolic-ref", "--short", "HEAD"]);

  return { name: path.basename(top), branch: branch ?? null };
}

// --- public ---------------------------------------------------------------

/** Folder to interrogate: whatever the active editor is in, else the first folder. */
function currentUri(): vscode.Uri | null {
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active?.scheme === "file") return active;
  return vscode.workspace.workspaceFolders?.[0]?.uri ?? null;
}

export class GitContext implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  /** Fires whenever the current repo or its HEAD may have changed. */
  readonly onDidChange = this.emitter.event;

  private readonly disposables: vscode.Disposable[] = [this.emitter];
  /** Per-repository HEAD listeners, torn down when a repo closes. */
  private readonly repoListeners = new Map<string, vscode.Disposable>();
  private api: GitAPI | null = null;
  private wired = false;

  constructor() {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.emitter.fire()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.emitter.fire()),
    );
  }

  /**
   * Resolve and subscribe to the git extension. Deliberately not called during
   * `activate()` — `extension.activate()` on vscode.git can take tens of ms and
   * the activation path has a <100ms budget (brief §6).
   */
  async wire(): Promise<void> {
    if (this.wired) return;
    this.wired = true;

    const ext = vscode.extensions.getExtension<GitExtension>("vscode.git");
    if (!ext) return; // no git extension → CLI fallback only

    let exports: GitExtension;
    try {
      exports = ext.isActive ? ext.exports : await ext.activate();
    } catch {
      return;
    }

    this.disposables.push(
      exports.onDidChangeEnablement(() => {
        this.api = exports.enabled ? exports.getAPI(1) : null;
        if (this.api) this.wireApi(this.api);
        this.emitter.fire();
      }),
    );

    if (!exports.enabled) return; // `git.enabled: false` → CLI fallback
    this.api = exports.getAPI(1);
    this.wireApi(this.api);
    this.emitter.fire();
  }

  private wireApi(api: GitAPI): void {
    this.disposables.push(
      api.onDidChangeState(() => {
        for (const repo of api.repositories) this.watchRepo(repo);
        this.emitter.fire();
      }),
      api.onDidOpenRepository((repo) => {
        this.watchRepo(repo);
        this.emitter.fire();
      }),
      api.onDidCloseRepository((repo) => {
        const key = repo.rootUri.toString();
        this.repoListeners.get(key)?.dispose();
        this.repoListeners.delete(key);
        this.emitter.fire();
      }),
    );
    for (const repo of api.repositories) this.watchRepo(repo);
  }

  /** Subscribe to a repository's state so branch switches re-render live. */
  private watchRepo(repo: GitRepository): void {
    const key = repo.rootUri.toString();
    if (this.repoListeners.has(key)) return;
    this.repoListeners.set(
      key,
      repo.state.onDidChange(() => this.emitter.fire()),
    );
  }

  /** The repository the user is currently in, if any. */
  private pickRepository(api: GitAPI): GitRepository | null {
    const uri = currentUri();
    if (uri) {
      const match = api.getRepository(uri);
      if (match) return match;
    }
    return api.repositories[0] ?? null;
  }

  /** Repo basename + branch for the current context, or null if not in a repo. */
  async getRepoContext(): Promise<RepoContext | null> {
    if (this.api && this.api.state === "initialized") {
      const repo = this.pickRepository(this.api);
      if (repo) {
        return {
          name: path.basename(repo.rootUri.fsPath),
          branch: repo.state.HEAD?.name ?? null,
        };
      }
      // API is up and knows of no repository — that's an answer, not a gap.
      if (this.api.repositories.length === 0) return null;
    }

    const uri = currentUri();
    if (!uri || uri.scheme !== "file") return null;
    const cwd = vscode.workspace.workspaceFolders?.some(
      (f) => f.uri.toString() === uri.toString(),
    )
      ? uri.fsPath
      : path.dirname(uri.fsPath);
    return repoContextViaCli(cwd);
  }

  dispose(): void {
    for (const d of this.repoListeners.values()) d.dispose();
    this.repoListeners.clear();
    for (const d of this.disposables) d.dispose();
  }
}
