import { extractIssueKey } from "@devpulse/shared";
import type { DevpulseStatus, LastSend } from "@devpulse/setup";
import { partialReason, type SetupState } from "./state";
import { normalizeDashboardUrl, timelineUrl } from "./urls";

/**
 * The status bar item's entire content, as a pure function of (setup state,
 * current branch, last-send breadcrumb). Keeping it out of `status-bar.ts` means
 * every rule below — including the branch-name nudge — is unit-tested without an
 * extension host.
 *
 * PRIVACY (spec §2): the only repo facts that appear here are the repo basename
 * and branch name, and they never leave the machine from this module.
 */

export type PresentationState = SetupState | "checking";

/** What the extension knows about the repo the user is looking at. */
export interface RepoContext {
  /** Repo directory basename — never a full path (spec §2). */
  name: string | null;
  branch: string | null;
}

export interface PresentationInput {
  state: PresentationState;
  /** `getStatus()` result, or null before the first detection finishes. */
  status: DevpulseStatus | null;
  dashboardUrl: string;
  repo: RepoContext | null;
  /** Injected so relative times are testable. */
  now: Date;
}

export interface StatusPresentation {
  text: string;
  /** Markdown source for the tooltip. */
  tooltip: string;
  /** Command id fired on click. */
  command: string;
  /** Render with the warning background — something needs the dev's attention. */
  warning: boolean;
  /** Screen-reader / hover-free label (status bar `text` carries icon codicons). */
  ariaLabel: string;
}

const BRANCH_NUDGE =
  "Name branches like `TEX-123-short-description` so time lands on the ticket.";

/** "3 minutes ago" / "just now" / "2 days ago". Coarse on purpose. */
export function formatRelativeTime(iso: string, now: Date): string | null {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  const seconds = Math.round((now.getTime() - then) / 1000);
  if (seconds < 0) return "just now";
  if (seconds < 45) return "just now";
  const units: Array<[label: string, size: number]> = [
    ["minute", 60],
    ["hour", 3600],
    ["day", 86400],
  ];
  let chosen = units[0]!;
  for (const unit of units) {
    if (seconds >= unit[1]) chosen = unit;
  }
  const value = Math.round(seconds / chosen[1]);
  return `${value} ${chosen[0]}${value === 1 ? "" : "s"} ago`;
}

/**
 * One line describing the agent's most recent send attempt. `markdown` is on
 * for the status bar tooltip and off for the plain-text output channel.
 */
export function formatLastSend(
  last: LastSend | null,
  now: Date,
  opts: { markdown?: boolean } = {},
): string {
  const code = (s: string) => (opts.markdown === false ? s : `\`${s}\``);
  if (!last?.at) return "Last event sent: none yet";
  const when = formatRelativeTime(last.at, now) ?? last.at;
  const outcome = last.ok === false ? "failed — spooled for retry" : "sent";
  const count = typeof last.attempted === "number" ? ` (${last.attempted})` : "";
  const hook = last.hook ? ` from ${code(last.hook)}` : "";
  return `Last event ${outcome}${count}${hook}: ${when}`;
}

/** Issue key for the current branch, or null. Branch only, per Phase 4. */
export function issueKeyForRepo(repo: RepoContext | null): string | null {
  return extractIssueKey(repo?.branch ?? null, null);
}

function repoLine(repo: RepoContext | null, issueKey: string | null): string[] {
  if (!repo?.branch) return [];
  const where = repo.name ? `\`${repo.name}\` on ` : "";
  const key = issueKey ? ` → **${issueKey}**` : "";
  return [`${where}\`${repo.branch}\`${key}`];
}

function activeFooter(input: PresentationInput): string[] {
  const url = normalizeDashboardUrl(input.dashboardUrl);
  const label = input.status?.credentials?.label;
  const lines = [
    `Dashboard: [${url}](${timelineUrl(url)})`,
    `Token: ${label ? `\`${label}\`` : "(unlabelled)"}`,
    formatLastSend(input.status?.lastSend ?? null, input.now),
  ];
  const spooled = input.status?.spoolCount ?? 0;
  if (spooled > 0) {
    lines.push(`${spooled} event${spooled === 1 ? "" : "s"} spooled offline`);
  }
  return lines;
}

export function statusPresentation(
  input: PresentationInput,
): StatusPresentation {
  const md = (lines: string[]) => lines.filter(Boolean).join("\n\n");

  if (input.state === "checking") {
    return {
      text: "$(pulse) DevPulse",
      tooltip: md(["**DevPulse**", "Checking this machine…"]),
      command: "devpulse.status",
      warning: false,
      ariaLabel: "DevPulse: checking",
    };
  }

  if (input.state === "not-installed") {
    return {
      text: "$(pulse) DevPulse: Set up",
      tooltip: md([
        "**DevPulse is not set up on this machine**",
        "Click to enable: you approve once in the browser, then commits, branch switches and pushes report metadata only (never code).",
      ]),
      command: "devpulse.enable",
      warning: false,
      ariaLabel: "DevPulse: not set up, click to enable",
    };
  }

  if (input.state === "partial") {
    const reason = input.status ? partialReason(input.status) : null;
    return {
      text: "$(pulse) DevPulse: Finish setup",
      tooltip: md([
        "**DevPulse setup is incomplete**",
        reason ?? "",
        "Click to finish — re-running setup is idempotent.",
      ]),
      command: "devpulse.enable",
      warning: true,
      ariaLabel: "DevPulse: setup incomplete, click to finish",
    };
  }

  // --- active ---------------------------------------------------------------
  const issueKey = issueKeyForRepo(input.repo);

  if (issueKey) {
    return {
      text: `$(pulse) ${issueKey}`,
      tooltip: md([
        `**DevPulse — ${issueKey}**`,
        ...repoLine(input.repo, issueKey),
        "Click to open this task in the dashboard.",
        ...activeFooter(input),
      ]),
      command: "devpulse.openCurrentTask",
      warning: false,
      ariaLabel: `DevPulse: current task ${issueKey}`,
    };
  }

  // On a branch, but its name carries no issue key — the nudge (brief §3.5).
  if (input.repo?.branch) {
    return {
      text: "$(pulse) DevPulse: no ticket",
      tooltip: md([
        "**DevPulse is running, but this branch has no issue key**",
        ...repoLine(input.repo, null),
        BRANCH_NUDGE,
        "Time is still recorded — it just groups by repo + branch instead of a ticket.",
        ...activeFooter(input),
      ]),
      command: "devpulse.openDashboard",
      warning: true,
      ariaLabel: "DevPulse: active, current branch has no issue key",
    };
  }

  // Active, but nothing git-shaped is open (no folder, or not a repo).
  return {
    text: "$(pulse) DevPulse ✓",
    tooltip: md([
      "**DevPulse is active on this machine**",
      "No git repository open in this window — hooks are machine-global, so commits anywhere still report.",
      ...activeFooter(input),
    ]),
    command: "devpulse.openDashboard",
    warning: false,
    ariaLabel: "DevPulse: active",
  };
}
