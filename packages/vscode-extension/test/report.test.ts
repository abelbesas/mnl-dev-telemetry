import { describe, expect, it } from "vitest";
import type { DevpulseStatus } from "@devpulse/setup";
import { statusReportLines } from "../src/lib/report";

const NOW = new Date("2026-07-29T10:00:00.000Z");

const status: DevpulseStatus = {
  home: "/home/dev/.devpulse",
  credentials: {
    token: "dp_secret",
    baseUrl: "https://dash.example",
    label: "abel-mbp",
    issuedAt: "2026-07-28T09:00:00.000Z",
  },
  hooksPath: "/home/dev/.devpulse/hooks",
  hooksPathIsOurs: true,
  chainedHooksPath: "/home/dev/.husky",
  hooks: ["post-commit", "post-checkout", "pre-push"],
  spoolCount: 0,
  lastSend: { at: "2026-07-29T09:58:00.000Z", hook: "post-commit", ok: true },
};

describe("statusReportLines", () => {
  const report = (repo: { name: string; branch: string | null } | null) =>
    statusReportLines({
      state: "active",
      status,
      dashboardUrl: "https://dash.example/",
      repo,
      now: NOW,
    }).join("\n");

  it("reports the install, mirroring `devpulse-setup status`", () => {
    const text = report({ name: "acme-web", branch: "TEX-9-thing" });
    expect(text).toContain("state:            active");
    expect(text).toContain("core.hooksPath:   /home/dev/.devpulse/hooks ← DevPulse");
    expect(text).toContain("chained path:     /home/dev/.husky");
    expect(text).toContain("post-commit, post-checkout, pre-push");
    expect(text).toContain("acme-web on TEX-9-thing → TEX-9");
  });

  it("calls out a branch with no issue key", () => {
    expect(report({ name: "acme-web", branch: "main" })).toContain(
      "no issue key in branch name",
    );
  });

  it("handles a window with no repository", () => {
    expect(report(null)).toContain("(no git repository)");
  });

  it("never prints the agent token (spec §2)", () => {
    expect(report({ name: "acme-web", branch: "main" })).not.toContain("dp_secret");
  });

  it("stays plain text — no markdown escapes leak in", () => {
    expect(report({ name: "acme-web", branch: "main" })).not.toContain("`");
  });

  it("states the heartbeat cadence and idle rule when running", () => {
    const on = statusReportLines({
      state: "active",
      status,
      dashboardUrl: "https://dash.example",
      repo: { name: "acme-web", branch: "main" },
      now: NOW,
      heartbeatRunning: true,
    }).join("\n");
    expect(on).toContain("heartbeat:        on — every 5 min while editing");
    expect(on).toContain("stops after 5 min idle");
  });

  it("says off when heartbeats are not running", () => {
    expect(report({ name: "acme-web", branch: "main" })).toContain(
      "heartbeat:        off",
    );
  });
});
