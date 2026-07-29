import { describe, expect, it } from "vitest";
import { eventBatchSchema, eventSchema } from "../src/events";
import { MAX_EVENTS_PER_BATCH } from "../src/config";

const uuid = "11111111-1111-4111-8111-111111111111";
const ts = "2026-07-23T09:00:00.000Z";

function commit(overrides: Record<string, unknown> = {}) {
  return {
    event_uuid: uuid,
    source: "git_hook",
    type: "commit",
    ts,
    repo: "mnl-dev-telemetry",
    branch: "feature/ABC-123",
    issue_key: "ABC-123",
    metadata: { files_changed: 3, insertions: 40, deletions: 5 },
    ...overrides,
  };
}

describe("eventSchema", () => {
  it("accepts a valid commit event", () => {
    const parsed = eventSchema.parse(commit());
    expect(parsed.type).toBe("commit");
  });

  it("strips unknown metadata keys (privacy §2)", () => {
    const parsed = eventSchema.parse(
      commit({
        metadata: {
          files_changed: 1,
          file_path: "/Users/dev/secret/project/src/keys.ts",
          diff: "super secret",
        },
      }),
    );
    expect(parsed.metadata).toEqual({ files_changed: 1 });
  });

  it("rejects a bad uuid", () => {
    expect(eventSchema.safeParse(commit({ event_uuid: "nope" })).success).toBe(
      false,
    );
  });

  it("rejects an unknown source", () => {
    expect(eventSchema.safeParse(commit({ source: "wat" })).success).toBe(false);
  });

  it("rejects an unknown event type", () => {
    expect(eventSchema.safeParse(commit({ type: "explode" })).success).toBe(
      false,
    );
  });

  it("rejects a malformed issue key", () => {
    expect(eventSchema.safeParse(commit({ issue_key: "abc-1" })).success).toBe(
      false,
    );
  });

  it("rejects a non-ISO timestamp", () => {
    expect(eventSchema.safeParse(commit({ ts: "yesterday" })).success).toBe(
      false,
    );
  });

  it("requires issue_key on task_start", () => {
    const base = {
      event_uuid: uuid,
      source: "mcp",
      type: "task_start",
      ts,
    };
    expect(eventSchema.safeParse(base).success).toBe(false);
    expect(
      eventSchema.safeParse({ ...base, issue_key: "DEV-1" }).success,
    ).toBe(true);
  });

  it("requires tool on tool_call metadata", () => {
    const base = {
      event_uuid: uuid,
      source: "mcp",
      type: "tool_call",
      ts,
    };
    expect(eventSchema.safeParse(base).success).toBe(false);
    expect(
      eventSchema.safeParse({ ...base, metadata: { tool: "task_start" } })
        .success,
    ).toBe(true);
  });

  it("allows a repo-less heartbeat", () => {
    expect(
      eventSchema.safeParse({
        event_uuid: uuid,
        source: "extension",
        type: "heartbeat",
        ts,
      }).success,
    ).toBe(true);
  });
});

describe("eventBatchSchema", () => {
  it("accepts a non-empty batch", () => {
    expect(eventBatchSchema.safeParse({ events: [commit()] }).success).toBe(
      true,
    );
  });

  it("rejects an empty batch", () => {
    expect(eventBatchSchema.safeParse({ events: [] }).success).toBe(false);
  });

  it("rejects a batch over the max size", () => {
    const events = Array.from({ length: MAX_EVENTS_PER_BATCH + 1 }, () =>
      commit(),
    );
    expect(eventBatchSchema.safeParse({ events }).success).toBe(false);
  });
});
