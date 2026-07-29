import { describe, expect, it } from "vitest";
import { extractIssueKey } from "@mnl-dev-telemetry/shared";
import type { MnlDevTelemetryStatus } from "@mnl-dev-telemetry/setup";
import {
  formatLastSend,
  formatRelativeTime,
  issueKeyForRepo,
  statusPresentation,
  type PresentationInput,
} from "../src/lib/presentation";

/**
 * Acceptance (brief §6): "Status bar shows the issue key on a `TEX-123-*` branch
 * and the nudge state on `main`" — expressed here as unit tests over the pure
 * presentation model, so the UI rules hold without an extension host.
 */

const NOW = new Date("2026-07-29T10:00:00.000Z");
const TOKEN = "dp_secret_agent_token_value";

function activeStatus(overrides: Partial<MnlDevTelemetryStatus> = {}): MnlDevTelemetryStatus {
  return {
    home: "/home/dev/.devpulse",
    credentials: {
      token: TOKEN,
      baseUrl: "https://dash.example",
      label: "abel-mbp",
      issuedAt: "2026-07-28T09:00:00.000Z",
    },
    hooksPath: "/home/dev/.devpulse/hooks",
    hooksPathIsOurs: true,
    chainedHooksPath: null,
    hooks: ["post-commit", "post-checkout", "pre-push"],
    spoolCount: 0,
    lastSend: {
      at: "2026-07-29T09:57:00.000Z",
      hook: "post-commit",
      attempted: 1,
      ok: true,
      spooled: 0,
    },
    ...overrides,
  };
}

function input(overrides: Partial<PresentationInput> = {}): PresentationInput {
  return {
    state: "active",
    status: activeStatus(),
    dashboardUrl: "https://dash.example",
    repo: { name: "acme-web", branch: "TEX-123-add-widget" },
    now: NOW,
    ...overrides,
  };
}

describe("issueKeyForRepo", () => {
  it("reuses the canonical shared extractor (branch only, per Phase 4)", () => {
    const branch = "feature/TEX-123-add-widget";
    expect(issueKeyForRepo({ name: "r", branch })).toBe("TEX-123");
    // Same answer as the shared package — the regex is never re-declared here.
    expect(issueKeyForRepo({ name: "r", branch })).toBe(
      extractIssueKey(branch, null),
    );
  });

  it("finds no key on main, or with no repo at all", () => {
    expect(issueKeyForRepo({ name: "r", branch: "main" })).toBeNull();
    expect(issueKeyForRepo({ name: "r", branch: null })).toBeNull();
    expect(issueKeyForRepo(null)).toBeNull();
  });
});

describe("statusPresentation — setup states", () => {
  it("offers setup when nothing is installed", () => {
    const p = statusPresentation(
      input({ state: "not-installed", status: null, repo: null }),
    );
    expect(p.text).toBe("$(pulse) MnlDevTelemetry: Set up");
    expect(p.command).toBe("mnlDevTelemetry.enable");
    expect(p.warning).toBe(false);
  });

  it("warns and explains when the install is only partial", () => {
    const p = statusPresentation(
      input({
        state: "partial",
        status: activeStatus({ hooksPathIsOurs: false, hooksPath: "/x/.husky" }),
      }),
    );
    expect(p.text).toBe("$(pulse) MnlDevTelemetry: Finish setup");
    expect(p.command).toBe("mnlDevTelemetry.enable");
    expect(p.warning).toBe(true);
    expect(p.tooltip).toContain("/x/.husky");
  });

  it("shows a neutral placeholder while state is still unknown", () => {
    const p = statusPresentation(input({ state: "checking", status: null }));
    expect(p.text).toBe("$(pulse) MnlDevTelemetry");
    expect(p.warning).toBe(false);
  });
});

describe("statusPresentation — active", () => {
  it("shows the issue key from a TEX-123-* branch and links to the task", () => {
    const p = statusPresentation(input());
    expect(p.text).toBe("$(pulse) TEX-123");
    expect(p.command).toBe("mnlDevTelemetry.openCurrentTask");
    expect(p.warning).toBe(false);
    expect(p.tooltip).toContain("acme-web");
    expect(p.tooltip).toContain("TEX-123-add-widget");
  });

  it("nudges on a branch with no issue key (e.g. main)", () => {
    const p = statusPresentation(
      input({ repo: { name: "acme-web", branch: "main" } }),
    );
    expect(p.text).toBe("$(pulse) MnlDevTelemetry: no ticket");
    expect(p.warning).toBe(true);
    expect(p.tooltip).toContain("TEX-123-short-description");
    expect(p.command).toBe("mnlDevTelemetry.openDashboard");
  });

  it("stays calm when no git repo is open", () => {
    const p = statusPresentation(input({ repo: null }));
    expect(p.text).toBe("$(pulse) MnlDevTelemetry ✓");
    expect(p.warning).toBe(false);
    expect(p.tooltip).toContain("machine-global");
  });

  it("puts dashboard URL, token label and last send in the tooltip", () => {
    const p = statusPresentation(input());
    expect(p.tooltip).toContain("https://dash.example");
    expect(p.tooltip).toContain("abel-mbp");
    expect(p.tooltip).toContain("3 minutes ago");
  });

  it("surfaces a non-empty offline spool", () => {
    const p = statusPresentation(
      input({ status: activeStatus({ spoolCount: 2 }) }),
    );
    expect(p.tooltip).toContain("2 events spooled offline");
  });

  it("never leaks the agent token into the tooltip (spec §2)", () => {
    const p = statusPresentation(input());
    expect(p.tooltip).not.toContain(TOKEN);
    expect(p.text).not.toContain(TOKEN);
  });
});

describe("formatRelativeTime", () => {
  it("is coarse and human", () => {
    expect(formatRelativeTime("2026-07-29T09:59:50.000Z", NOW)).toBe("just now");
    expect(formatRelativeTime("2026-07-29T09:58:00.000Z", NOW)).toBe(
      "2 minutes ago",
    );
    expect(formatRelativeTime("2026-07-29T09:00:00.000Z", NOW)).toBe("1 hour ago");
    expect(formatRelativeTime("2026-07-27T10:00:00.000Z", NOW)).toBe("2 days ago");
  });

  it("tolerates clock skew and garbage", () => {
    expect(formatRelativeTime("2026-07-29T10:05:00.000Z", NOW)).toBe("just now");
    expect(formatRelativeTime("not-a-date", NOW)).toBeNull();
  });
});

describe("formatLastSend", () => {
  it("reports a failure as spooled for retry", () => {
    const line = formatLastSend(
      { at: "2026-07-29T09:58:00.000Z", hook: "pre-push", attempted: 3, ok: false },
      NOW,
    );
    expect(line).toContain("failed — spooled for retry");
    expect(line).toContain("(3)");
  });

  it("handles a machine that has never sent", () => {
    expect(formatLastSend(null, NOW)).toBe("Last event sent: none yet");
  });

  it("drops markdown when asked (plain-text output channel)", () => {
    const line = formatLastSend(
      { at: "2026-07-29T09:58:00.000Z", hook: "post-commit", ok: true },
      NOW,
      { markdown: false },
    );
    expect(line).not.toContain("`");
    expect(line).toContain("post-commit");
  });
});
