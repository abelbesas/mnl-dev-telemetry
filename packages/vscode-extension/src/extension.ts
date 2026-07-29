import * as vscode from "vscode";
import { getStatus, type MnlDevTelemetryStatus } from "@mnl-dev-telemetry/setup";
import { GitContext } from "./git-context";
import { HeartbeatSender } from "./heartbeat";
import {
  issueKeyForRepo,
  statusPresentation,
  type PresentationState,
  type RepoContext,
} from "./lib/presentation";
import { statusReportLines } from "./lib/report";
import { setupStateFromStatus } from "./lib/state";
import {
  normalizeDashboardUrl,
  taskUrl,
  timelineUrl,
} from "./lib/urls";
import { runEnableFlow, runUninstallFlow } from "./setup-flow";
import { MnlDevTelemetryStatusBar } from "./status-bar";

/**
 * MnlDevTelemetry for VS Code / Cursor (docs/phase-6-extension-brief.md). For setup and
 * visibility it is a thin wrapper around `@mnl-dev-telemetry/setup`; the one thing it
 * sends on its own is a presence heartbeat (`heartbeat.ts`, §4a), which is what
 * stops sessions from starting at the first commit and ending at the last.
 *
 * It never reads code and never holds Jira/Tempo credentials. Git hooks are
 * machine-global, so if this extension is disabled commit telemetry keeps
 * flowing — only the heartbeat accuracy is editor-bound.
 *
 * Activation does no fs, git or network work — everything is deferred to a
 * microtask after `activate()` returns (brief §6: <100ms activation budget).
 */

const WELCOME_DISMISSED_KEY = "mnlDevTelemetry.welcomeDismissed";
/** Keeps the tooltip's "last event sent" honest without user interaction. */
const REFRESH_INTERVAL_MS = 60_000;

function dashboardUrlSetting(): string {
  return normalizeDashboardUrl(
    vscode.workspace.getConfiguration("mnlDevTelemetry").get<string>("dashboardUrl"),
  );
}

class MnlDevTelemetry implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly statusBar = new MnlDevTelemetryStatusBar();
  private readonly git = new GitContext();
  private readonly channel: vscode.OutputChannel;
  private readonly heartbeat: HeartbeatSender;

  private state: PresentationState = "checking";
  private status: MnlDevTelemetryStatus | null = null;
  private repo: RepoContext | null = null;

  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshing = false;
  private refreshQueued = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.channel = vscode.window.createOutputChannel("MnlDevTelemetry");
    // Constructed here (cheap — it only subscribes to editor events) but not
    // started until state detection confirms the machine is set up.
    this.heartbeat = new HeartbeatSender(this.git, this.channel);
    this.disposables.push(
      this.channel,
      this.statusBar,
      this.git,
      this.heartbeat,
    );
    this.render();
  }

  // --- lifecycle ----------------------------------------------------------

  /** Register everything that is cheap enough for the activation path. */
  wireCommands(): void {
    const cmd = (id: string, fn: () => unknown) =>
      this.disposables.push(vscode.commands.registerCommand(id, fn));

    cmd("mnlDevTelemetry.enable", () => this.enable());
    cmd("mnlDevTelemetry.status", () => this.showStatusReport());
    cmd("mnlDevTelemetry.openDashboard", () => this.openDashboard());
    cmd("mnlDevTelemetry.openCurrentTask", () => this.openCurrentTask());
    cmd("mnlDevTelemetry.uninstall", () => this.uninstall());

    this.disposables.push(
      this.git.onDidChange(() => this.scheduleRefresh()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("mnlDevTelemetry.dashboardUrl")) this.render();
      }),
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused) this.scheduleRefresh();
      }),
    );

    const interval = setInterval(() => {
      if (vscode.window.state.focused) this.scheduleRefresh();
    }, REFRESH_INTERVAL_MS);
    this.disposables.push({ dispose: () => clearInterval(interval) });
  }

  /** Deferred init — the first thing that is allowed to touch fs/git. */
  async start(): Promise<void> {
    await this.git.wire();
    await this.refresh();
    await this.maybeShowWelcome();
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    for (const d of this.disposables) d.dispose();
  }

  // --- state --------------------------------------------------------------

  /** Coalesce bursts of git events into one refresh. */
  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, 150);
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshQueued = true;
      return;
    }
    this.refreshing = true;
    try {
      // Sync fs reads + one `git config --global` subprocess. Cheap, but never
      // on the activation path.
      try {
        this.status = getStatus();
        this.state = setupStateFromStatus(this.status);
      } catch (err) {
        this.channel.appendLine(
          `! could not read MnlDevTelemetry state: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      this.repo = await this.git.getRepoContext();
      this.render();
      // Heartbeats only run on a set-up machine; a half-install or an uninstall
      // silences them immediately (§4a: "if the user is not set up, send
      // nothing").
      if (this.state === "active") this.heartbeat.start();
      else this.heartbeat.stop();
    } finally {
      this.refreshing = false;
      if (this.refreshQueued) {
        this.refreshQueued = false;
        this.scheduleRefresh();
      }
    }
  }

  private render(): void {
    this.statusBar.apply(
      statusPresentation({
        state: this.state,
        status: this.status,
        dashboardUrl: dashboardUrlSetting(),
        repo: this.repo,
        now: new Date(),
      }),
    );
  }

  // --- commands -----------------------------------------------------------

  private async enable(): Promise<void> {
    const result = await runEnableFlow(
      this.context,
      this.channel,
      dashboardUrlSetting(),
    );
    await this.refresh();

    if (result.cancelled) {
      void vscode.window.showInformationMessage(
        "MnlDevTelemetry setup cancelled. Run “MnlDevTelemetry: Enable MnlDevTelemetry on this machine” whenever you're ready.",
      );
      return;
    }
    if (!result.ok) return;

    const choice = await vscode.window.showInformationMessage(
      "MnlDevTelemetry is active. Commits, branch switches and pushes now report metadata only — never code.",
      "Open dashboard",
    );
    if (choice === "Open dashboard") await this.openDashboard();
  }

  private async uninstall(): Promise<void> {
    if (await runUninstallFlow(this.channel)) await this.refresh();
  }

  private async openDashboard(): Promise<void> {
    await vscode.env.openExternal(
      vscode.Uri.parse(timelineUrl(dashboardUrlSetting())),
    );
  }

  private async openCurrentTask(): Promise<void> {
    await this.refresh();
    const issueKey = issueKeyForRepo(this.repo);
    if (!issueKey) {
      const choice = await vscode.window.showInformationMessage(
        this.repo?.branch
          ? `No issue key in branch “${this.repo.branch}”. Name branches like TEX-123-short-description so time lands on the ticket.`
          : "No git repository open in this window.",
        "Open dashboard",
      );
      if (choice === "Open dashboard") await this.openDashboard();
      return;
    }
    await vscode.env.openExternal(
      vscode.Uri.parse(taskUrl(dashboardUrlSetting(), issueKey)),
    );
  }

  private async showStatusReport(): Promise<void> {
    await this.refresh();
    if (!this.status) {
      void vscode.window.showWarningMessage("MnlDevTelemetry: could not read local state.");
      return;
    }
    this.channel.appendLine("");
    for (const line of statusReportLines({
      state: this.state === "checking" ? "not-installed" : this.state,
      status: this.status,
      dashboardUrl: dashboardUrlSetting(),
      repo: this.repo,
      now: new Date(),
      heartbeatRunning: this.heartbeat.running,
    })) {
      this.channel.appendLine(line);
    }
    this.channel.show(true);
  }

  // --- first run ----------------------------------------------------------

  private async maybeShowWelcome(): Promise<void> {
    if (this.state === "active") return;
    if (this.context.globalState.get<boolean>(WELCOME_DISMISSED_KEY)) return;

    const choice = await vscode.window.showInformationMessage(
      this.state === "partial"
        ? "MnlDevTelemetry setup is incomplete on this machine. Finish it to start reporting time against your tickets."
        : "Enable MnlDevTelemetry to track task time automatically? You approve once in the browser; only metadata (repo, branch, ticket, diff counts) is ever sent — never code.",
      "Enable MnlDevTelemetry",
      "Not now",
      "Don't ask again",
    );
    if (choice === "Enable MnlDevTelemetry") {
      await this.enable();
    } else if (choice === "Don't ask again") {
      await this.context.globalState.update(WELCOME_DISMISSED_KEY, true);
    }
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const mnlDevTelemetry = new MnlDevTelemetry(context);
  mnlDevTelemetry.wireCommands();
  context.subscriptions.push(mnlDevTelemetry);

  // Everything that touches fs, git or the network happens after activation
  // returns, so the extension host is never blocked at startup (brief §6).
  setTimeout(() => {
    void mnlDevTelemetry.start();
  }, 0);
}

export function deactivate(): void {
  // Nothing to do: disposables are owned by `context.subscriptions`, and
  // telemetry keeps flowing regardless (git hooks are machine-global).
}
