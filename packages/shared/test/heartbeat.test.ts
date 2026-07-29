import { describe, expect, it, vi } from "vitest";
import {
  HEARTBEAT_IDLE_MINUTES,
  HEARTBEAT_INTERVAL_MINUTES,
  IngestClient,
  STITCH_GAP_MINUTES,
  eventSchema,
  heartbeatRequestSchema,
  heartbeatResponseSchema,
} from "../src/index";

/**
 * Heartbeat contract (Phase 6 §4a). The endpoint exists to be cheap to call, but
 * a heartbeat is still an ordinary event — these tests pin both properties, plus
 * the privacy guarantee that unknown keys are stripped rather than stored.
 */

const UUID = "eb21a3b7-2066-4db7-99df-375675a95147";
const TS = "2026-07-29T02:00:00.000Z";

describe("heartbeatRequestSchema", () => {
  it("accepts the minimal payload an editor sends", () => {
    const parsed = heartbeatRequestSchema.parse({
      event_uuid: UUID,
      ts: TS,
      repo: "acme-web",
      branch: "TEX-123-add-widget",
    });
    // Defaults make the endpoint cheap to call without inventing a second shape.
    expect(parsed.type).toBe("heartbeat");
    expect(parsed.source).toBe("extension");
  });

  it("produces something the event union also accepts", () => {
    const parsed = heartbeatRequestSchema.parse({
      event_uuid: UUID,
      ts: TS,
      repo: "acme-web",
      branch: "TEX-123-add-widget",
    });
    // This is what lets the route reuse `toEventRow` and the stitcher stay
    // untouched — a heartbeat is not a parallel format.
    expect(eventSchema.safeParse(parsed).success).toBe(true);
  });

  it("strips anything that would leak code or paths (spec §2)", () => {
    const parsed = heartbeatRequestSchema.parse({
      event_uuid: UUID,
      ts: TS,
      repo: "acme-web",
      branch: "main",
      file: "/Users/abel/secret/app.ts",
      file_name: "app.ts",
      content: "const apiKey = '...'",
      metadata: { file_path: "/etc/passwd", lines: 42 },
    });
    expect(parsed).not.toHaveProperty("file");
    expect(parsed).not.toHaveProperty("file_name");
    expect(parsed).not.toHaveProperty("content");
    expect(parsed.metadata).toEqual({});
    expect(JSON.stringify(parsed)).not.toContain("secret");
  });

  it("rejects a non-uuid idempotency key and a non-ISO timestamp", () => {
    expect(
      heartbeatRequestSchema.safeParse({ event_uuid: "nope", ts: TS }).success,
    ).toBe(false);
    expect(
      heartbeatRequestSchema.safeParse({ event_uuid: UUID, ts: "yesterday" })
        .success,
    ).toBe(false);
  });

  it("allows a repo with no branch (detached HEAD)", () => {
    expect(
      heartbeatRequestSchema.safeParse({
        event_uuid: UUID,
        ts: TS,
        repo: "acme-web",
      }).success,
    ).toBe(true);
  });
});

describe("heartbeatResponseSchema", () => {
  it("is one event's worth of outcome", () => {
    expect(heartbeatResponseSchema.parse({ inserted: 1, skipped: 0 })).toEqual({
      inserted: 1,
      skipped: 0,
    });
    expect(heartbeatResponseSchema.safeParse({ inserted: 2, skipped: 0 }).success).toBe(
      false,
    );
  });
});

describe("heartbeat cadence constants", () => {
  it("pings far more often than the stitcher's session gap", () => {
    // If this ever inverts, pings would split sessions instead of bracketing
    // them — the exact opposite of the intent (§4a).
    expect(HEARTBEAT_INTERVAL_MINUTES).toBeLessThan(STITCH_GAP_MINUTES);
    expect(HEARTBEAT_IDLE_MINUTES).toBeLessThanOrEqual(STITCH_GAP_MINUTES);
  });
});

describe("IngestClient.sendHeartbeat", () => {
  it("posts to /api/ingest/heartbeat with the bearer token", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ inserted: 1, skipped: 0 }),
    })) as unknown as typeof fetch;

    const client = new IngestClient({
      baseUrl: "https://dash.example/",
      token: "dp_tok",
      fetchImpl,
    });
    const res = await client.sendHeartbeat({
      event_uuid: UUID,
      ts: TS,
      repo: "acme-web",
      branch: "TEX-123-add-widget",
    });

    expect(res).toEqual({ inserted: 1, skipped: 0 });
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } })
      .mock.calls[0]!;
    expect(url).toBe("https://dash.example/api/ingest/heartbeat");
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer dp_tok",
    );
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ type: "heartbeat", source: "extension" });
  });

  it("throws on a non-2xx so the caller can swallow it", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: "invalid or revoked token" }),
    })) as unknown as typeof fetch;

    const client = new IngestClient({
      baseUrl: "https://dash.example",
      token: "bad",
      fetchImpl,
    });
    await expect(
      client.sendHeartbeat({ event_uuid: UUID, ts: TS, repo: "r" }),
    ).rejects.toThrow(/401/);
  });

  it("still sends a batch of events to /events (unchanged)", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ inserted: 1, skipped: 0, skipped_uuids: [] }),
    })) as unknown as typeof fetch;

    const client = new IngestClient({
      baseUrl: "https://dash.example",
      token: "dp_tok",
      fetchImpl,
    });
    await client.sendEvents([
      {
        event_uuid: UUID,
        source: "git_hook",
        type: "commit",
        ts: TS,
        repo: "acme-web",
      },
    ]);
    const [url] = (fetchImpl as unknown as { mock: { calls: [string][] } }).mock
      .calls[0]!;
    expect(url).toBe("https://dash.example/api/ingest/events");
  });
});
