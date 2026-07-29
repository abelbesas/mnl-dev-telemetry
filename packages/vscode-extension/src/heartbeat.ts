import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { IngestClient } from "@mnl-dev-telemetry/shared";
import { readCredentials, mnlDevTelemetryPaths } from "@mnl-dev-telemetry/setup";
import type { GitContext } from "./git-context";
import {
  HEARTBEAT_INTERVAL_MS,
  isActivityScheme,
  shouldSendHeartbeat,
} from "./lib/heartbeat";

/**
 * Editor presence heartbeats (Phase 6 §4a) — the phase's accuracy payoff and the
 * one thing the extension sends on its own.
 *
 * Git-only data starts a session at the first commit and ends it at the last, so
 * a dev who works 10:00–10:30 and commits once at 10:30 reads as 0 minutes.
 * A ping every 5 minutes while they are actually editing brackets the session at
 * both ends. It is agent-agnostic: it helps the dev who never touches AI, who is
 * the worst-served user today.
 *
 * PRIVACY (spec §2): a heartbeat carries repo basename, branch and a timestamp.
 * Nothing else. Document-change events are used only to stamp a clock — the URI,
 * file name and contents are never read.
 *
 * POSTURE: same as the git hooks — 2s budget, fire-and-forget, never block or
 * interrupt the editor. A dropped ping is fine; the next one is 5 minutes away,
 * so unlike the hooks there is deliberately no spool behind this.
 */

/** How often we re-evaluate. Shorter than the interval so a resumed session
 *  pings promptly after idling out, instead of waiting a full interval. */
const TICK_MS = 60_000;

export class HeartbeatSender implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastActivityAt: number | null = null;
  private lastSentAt: number | null = null;
  private sending = false;

  constructor(
    private readonly git: GitContext,
    private readonly channel: vscode.OutputChannel,
    /** Injected in tests; defaults to the real clock. */
    private readonly now: () => number = () => Date.now(),
  ) {
    const touch = () => {
      this.lastActivityAt = this.now();
    };

    this.disposables.push(
      // Only the scheme is inspected — see isActivityScheme.
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (isActivityScheme(e.document.uri.scheme)) touch();
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (isActivityScheme(doc.uri.scheme)) touch();
      }),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (isActivityScheme(e.textEditor.document.uri.scheme)) touch();
      }),
    );
  }

  /** Begin ticking. Idempotent — safe to call on every state refresh. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.channel.appendLine(
      `heartbeat: watching for activity (ping every ${
        HEARTBEAT_INTERVAL_MS / 60_000
      } min while editing)`,
    );
  }

  /** Stop ticking (machine not set up, or the extension is shutting down). */
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  get running(): boolean {
    return this.timer !== undefined;
  }

  /**
   * Evaluate the idle rule and send if due. Exposed for tests so they don't have
   * to wait out a real timer.
   */
  async tick(): Promise<void> {
    if (this.sending) return;

    const paths = mnlDevTelemetryPaths();
    const creds = readCredentials(paths.credentials);
    const repo = await this.git.getRepoContext();

    const decision = shouldSendHeartbeat({
      now: this.now(),
      lastActivityAt: this.lastActivityAt,
      lastSentAt: this.lastSentAt,
      hasCredentials: creds !== null,
      repo,
    });
    if (!decision.send || !creds || !repo?.name) return;

    this.sending = true;
    // Stamped before the request so a slow/failed send can't cause a burst of
    // retries — a missed ping is cheaper than a double-counted one.
    this.lastSentAt = this.now();
    try {
      const client = new IngestClient({
        baseUrl: creds.baseUrl,
        token: creds.token,
        timeoutMs: 2000,
      });
      await client.sendHeartbeat({
        event_uuid: randomUUID(),
        ts: new Date(this.now()).toISOString(),
        repo: repo.name,
        ...(repo.branch ? { branch: repo.branch } : {}),
      });
    } catch (err) {
      // Never surface: telemetry must not interrupt the editor.
      this.channel.appendLine(
        `heartbeat: send failed (will retry on the next interval): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      this.sending = false;
    }
  }

  dispose(): void {
    this.stop();
    for (const d of this.disposables) d.dispose();
  }
}
