import { describe, expect, it } from "vitest";
import type { IngestEvent } from "@devpulse/shared";
import {
  dedupeEvents,
  parseBearerToken,
  RateLimiter,
  toEventRow,
} from "../src/lib/ingest";

const ts = "2026-07-23T09:00:00.000Z";

function ev(uuid: string, overrides: Partial<IngestEvent> = {}): IngestEvent {
  return {
    event_uuid: uuid,
    source: "git_hook",
    type: "commit",
    ts,
    repo: "devpulse",
    branch: "feature/ABC-123",
    ...overrides,
  } as IngestEvent;
}

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";

describe("parseBearerToken", () => {
  it("extracts the token", () => {
    expect(parseBearerToken("Bearer dp_abc")).toBe("dp_abc");
    expect(parseBearerToken("bearer dp_abc")).toBe("dp_abc");
  });

  it("returns null for missing / malformed headers", () => {
    expect(parseBearerToken(null)).toBeNull();
    expect(parseBearerToken("Basic xyz")).toBeNull();
    expect(parseBearerToken("Bearer ")).toBeNull();
  });
});

describe("dedupeEvents", () => {
  it("keeps the first occurrence and reports duplicates", () => {
    const { unique, duplicateUuids } = dedupeEvents([
      ev(U1),
      ev(U2),
      ev(U1),
    ]);
    expect(unique).toHaveLength(2);
    expect(duplicateUuids).toEqual([U1]);
  });
});

describe("toEventRow", () => {
  it("derives the issue key from the branch when none is provided", () => {
    const row = toEventRow("user-1", ev(U1, { issue_key: undefined }));
    expect(row.issueKey).toBe("ABC-123");
    expect(row.userId).toBe("user-1");
    expect(row.eventUuid).toBe(U1);
    expect(row.ts).toBeInstanceOf(Date);
  });

  it("prefers an explicit issue key", () => {
    const row = toEventRow("user-1", ev(U1, { issue_key: "DEV-9" }));
    expect(row.issueKey).toBe("DEV-9");
  });

  it("leaves issue key null when nothing matches", () => {
    const row = toEventRow(
      "user-1",
      ev(U1, { issue_key: undefined, branch: "main" }),
    );
    expect(row.issueKey).toBeNull();
  });

  it("defaults metadata to an empty object", () => {
    const row = toEventRow("user-1", ev(U1));
    expect(row.metadata).toEqual({});
  });
});

describe("RateLimiter", () => {
  it("allows up to the limit then blocks within the window", () => {
    const rl = new RateLimiter(2, 1000);
    expect(rl.check("k", 0).allowed).toBe(true);
    expect(rl.check("k", 100).allowed).toBe(true);
    const blocked = rl.check("k", 200);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
  });

  it("resets after the window elapses", () => {
    const rl = new RateLimiter(1, 1000);
    expect(rl.check("k", 0).allowed).toBe(true);
    expect(rl.check("k", 500).allowed).toBe(false);
    expect(rl.check("k", 1001).allowed).toBe(true);
  });

  it("tracks keys independently", () => {
    const rl = new RateLimiter(1, 1000);
    expect(rl.check("a", 0).allowed).toBe(true);
    expect(rl.check("b", 0).allowed).toBe(true);
  });
});
