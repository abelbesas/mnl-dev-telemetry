import { describe, expect, it } from "vitest";
import { eventSchema } from "@mnl-dev-telemetry/shared";
import {
  buildEvent,
  detectAiCoAuthor,
  parseShortstat,
  type HookContext,
} from "../src/event";

const UUID = "11111111-1111-4111-8111-111111111111";
const TS = "2026-07-23T09:00:00.000Z";

describe("parseShortstat", () => {
  it("parses a full shortstat line", () => {
    expect(
      parseShortstat(" 3 files changed, 42 insertions(+), 7 deletions(-)"),
    ).toEqual({ files_changed: 3, insertions: 42, deletions: 7 });
  });

  it("handles singular / missing clauses", () => {
    expect(parseShortstat(" 1 file changed, 1 insertion(+)")).toEqual({
      files_changed: 1,
      insertions: 1,
    });
    expect(parseShortstat(null)).toEqual({});
    expect(parseShortstat("")).toEqual({});
  });
});

describe("detectAiCoAuthor", () => {
  it("matches a known AI co-author trailer", () => {
    const msg = "Fix bug\n\nCo-authored-by: Claude <noreply@anthropic.com>";
    expect(detectAiCoAuthor(msg)).toContain("Claude");
  });

  it("ignores non-AI co-authors and missing trailers", () => {
    expect(
      detectAiCoAuthor("Feature\n\nCo-authored-by: Jane Dev <jane@x.io>"),
    ).toBeNull();
    expect(detectAiCoAuthor("no trailer here")).toBeNull();
    expect(detectAiCoAuthor(null)).toBeNull();
  });
});

describe("buildEvent", () => {
  it("builds a schema-valid commit event with diff stats and issue key", () => {
    const ctx: HookContext = {
      hook: "post-commit",
      repo: "mnl-dev-telemetry",
      branch: "feature/ABC-123-thing",
      sha: "a1b2c3d4e5f6a7b8",
      shortstat: " 2 files changed, 10 insertions(+), 1 deletion(-)",
      aiCoAuthor: "Claude <noreply@anthropic.com>",
    };
    const event = buildEvent(ctx, { uuid: UUID, ts: TS });
    expect(event).not.toBeNull();
    // Must satisfy the shared contract exactly.
    expect(() => eventSchema.parse(event)).not.toThrow();
    expect(event).toMatchObject({
      type: "commit",
      source: "git_hook",
      repo: "mnl-dev-telemetry",
      issue_key: "ABC-123",
      metadata: {
        sha: "a1b2c3d4e5f6a7b8",
        files_changed: 2,
        insertions: 10,
        deletions: 1,
        ai_co_author: "Claude <noreply@anthropic.com>",
      },
    });
  });

  it("emits branch_switch only for real branch checkouts", () => {
    const base: HookContext = {
      hook: "post-checkout",
      repo: "mnl-dev-telemetry",
      branch: "DEV-9-feature",
      fromBranch: "main",
      toBranch: "DEV-9-feature",
      checkoutFlag: "1",
    };
    const switched = buildEvent(base, { uuid: UUID, ts: TS });
    expect(switched).toMatchObject({
      type: "branch_switch",
      issue_key: "DEV-9",
      metadata: { from_branch: "main", to_branch: "DEV-9-feature" },
    });
    expect(() => eventSchema.parse(switched)).not.toThrow();

    // File checkout (flag 0) → nothing.
    expect(buildEvent({ ...base, checkoutFlag: "0" }, { uuid: UUID, ts: TS })).toBeNull();

    // Same branch → nothing.
    expect(
      buildEvent(
        { ...base, fromBranch: "main", toBranch: "main", branch: "main" },
        { uuid: UUID, ts: TS },
      ),
    ).toBeNull();
  });

  it("builds a push event with remote and commit count", () => {
    const ctx: HookContext = {
      hook: "pre-push",
      repo: "mnl-dev-telemetry",
      branch: "main",
      remote: "origin",
      commitCount: 3,
    };
    const event = buildEvent(ctx, { uuid: UUID, ts: TS });
    expect(event).toMatchObject({
      type: "push",
      metadata: { remote: "origin", commit_count: 3 },
    });
    expect(() => eventSchema.parse(event)).not.toThrow();
  });

  it("omits optional metadata cleanly when git facts are unavailable", () => {
    const event = buildEvent(
      { hook: "pre-push", repo: "mnl-dev-telemetry", branch: "main", remote: null, commitCount: null },
      { uuid: UUID, ts: TS },
    );
    expect(event).toMatchObject({ type: "push", metadata: {} });
    expect(() => eventSchema.parse(event)).not.toThrow();
  });
});
