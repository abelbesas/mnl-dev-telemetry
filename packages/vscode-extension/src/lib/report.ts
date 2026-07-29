import type { DevpulseStatus } from "@devpulse/setup";
import { formatLastSend, issueKeyForRepo, type RepoContext } from "./presentation";
import type { SetupState } from "./state";
import { normalizeDashboardUrl } from "./urls";

/**
 * Plain-text status report for the DevPulse output channel — the editor
 * equivalent of `devpulse-setup status`, built from the same `getStatus()` data.
 * Pure so its content is testable.
 */
export function statusReportLines(input: {
  state: SetupState;
  status: DevpulseStatus;
  dashboardUrl: string;
  repo: RepoContext | null;
  now: Date;
}): string[] {
  const { status } = input;
  const issueKey = issueKeyForRepo(input.repo);
  const lines = [
    "DevPulse status",
    `  state:            ${input.state}`,
    `  home:             ${status.home}`,
    `  logged in:        ${status.credentials ? "yes" : "no"}`,
  ];

  if (status.credentials) {
    lines.push(
      `  dashboard URL:    ${status.credentials.baseUrl}`,
      `  token label:      ${status.credentials.label ?? "(none)"}`,
      `  token issued:     ${status.credentials.issuedAt ?? "(unknown)"}`,
    );
  }

  lines.push(
    `  core.hooksPath:   ${status.hooksPath ?? "(unset)"}${
      status.hooksPathIsOurs ? " ← DevPulse" : ""
    }`,
  );
  if (status.chainedHooksPath) {
    lines.push(`  chained path:     ${status.chainedHooksPath}`);
  }
  lines.push(
    `  hooks installed:  ${status.hooks.length ? status.hooks.join(", ") : "(none)"}`,
    `  spooled events:   ${status.spoolCount}`,
    `  ${formatLastSend(status.lastSend, input.now, { markdown: false })}`,
    `  setting URL:      ${normalizeDashboardUrl(input.dashboardUrl)}`,
    `  this window:      ${
      input.repo?.branch
        ? `${input.repo.name ?? "(repo)"} on ${input.repo.branch}${
            issueKey ? ` → ${issueKey}` : " (no issue key in branch name)"
          }`
        : "(no git repository)"
    }`,
  );

  return lines;
}
