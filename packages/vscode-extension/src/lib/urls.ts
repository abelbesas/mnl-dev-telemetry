/**
 * Dashboard URL helpers. Pure — no `vscode`, no fs — so they are unit-tested
 * directly (`src/lib/**` must stay editor-free; see test/no-vscode-imports.test.ts).
 */

/** Shipped default: the deployment the team demos off (brief §4, setting default). */
export const DEFAULT_DASHBOARD_URL =
  "https://mnl-dev-telemetry-dashboard.vercel.app";

/**
 * Normalise a user-typed setting into a base URL with no trailing slash.
 * Falls back to the default for blank input, and assumes `https://` when the
 * scheme is missing (a very likely typo in a settings box).
 */
export function normalizeDashboardUrl(raw: string | undefined | null): string {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return DEFAULT_DASHBOARD_URL;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withScheme.replace(/\/+$/, "");
}

/** The SSO-gated page where a device code is approved (Phase 4). */
export function activateUrl(baseUrl: string): string {
  return `${normalizeDashboardUrl(baseUrl)}/activate`;
}

export function timelineUrl(baseUrl: string): string {
  return `${normalizeDashboardUrl(baseUrl)}/timeline`;
}

/** Task detail for an issue key, e.g. `…/tasks/TEX-123`. */
export function taskUrl(baseUrl: string, issueKey: string): string {
  return `${normalizeDashboardUrl(baseUrl)}/tasks/${encodeURIComponent(issueKey)}`;
}
