import { describe, expect, it, vi } from "vitest";
import type { IngestEvent } from "@devpulse/shared";
import { flushSpool, SPOOL_CAP } from "../src/spool";

function ev(n: number): IngestEvent {
  return {
    event_uuid: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    source: "git_hook",
    type: "commit",
    ts: "2026-07-23T09:00:00.000Z",
    repo: "devpulse",
    metadata: {},
  } as IngestEvent;
}

describe("flushSpool", () => {
  it("does nothing when there is nothing to send", async () => {
    const send = vi.fn(async () => {});
    const r = await flushSpool({ pending: [], fresh: [], send });
    expect(send).not.toHaveBeenCalled();
    expect(r).toEqual({ attempted: 0, sent: true, remaining: [], dropped: 0 });
  });

  it("sends fresh + pending together and clears the spool on success", async () => {
    const send = vi.fn(async (_events: IngestEvent[]) => {});
    const r = await flushSpool({
      pending: [ev(1), ev(2)],
      fresh: [ev(3)],
      send,
    });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![0]).toHaveLength(3);
    expect(r.sent).toBe(true);
    expect(r.remaining).toEqual([]);
    expect(r.attempted).toBe(3);
  });

  it("keeps everything spooled when the send fails (offline)", async () => {
    const send = vi.fn(async () => {
      throw new Error("network down");
    });
    const r = await flushSpool({ pending: [ev(1)], fresh: [ev(2)], send });
    expect(r.sent).toBe(false);
    expect(r.remaining.map((e) => e.event_uuid)).toEqual([
      ev(1).event_uuid,
      ev(2).event_uuid,
    ]);
    expect(r.dropped).toBe(0);
  });

  it("retries spooled events on the next invocation once back online", async () => {
    // 1st invocation: offline.
    const offline = vi.fn(async () => {
      throw new Error("down");
    });
    const first = await flushSpool({ pending: [], fresh: [ev(1)], send: offline });
    expect(first.sent).toBe(false);
    expect(first.remaining).toHaveLength(1);

    // 2nd invocation: online, carries the spooled event + a new one.
    const online = vi.fn(async (_events: IngestEvent[]) => {});
    const second = await flushSpool({
      pending: first.remaining,
      fresh: [ev(2)],
      send: online,
    });
    expect(online).toHaveBeenCalledOnce();
    expect(online.mock.calls[0]![0].map((e: IngestEvent) => e.event_uuid)).toEqual([
      ev(1).event_uuid,
      ev(2).event_uuid,
    ]);
    expect(second.sent).toBe(true);
    expect(second.remaining).toEqual([]);
  });

  it("drops the oldest events beyond the cap on repeated failures", async () => {
    const cap = 3;
    const send = vi.fn(async () => {
      throw new Error("down");
    });
    const pending = [ev(1), ev(2), ev(3)];
    const r = await flushSpool({ pending, fresh: [ev(4)], send, cap });
    expect(r.remaining.map((e) => e.event_uuid)).toEqual([
      ev(2).event_uuid,
      ev(3).event_uuid,
      ev(4).event_uuid,
    ]);
    expect(r.dropped).toBe(1);
  });

  it("keeps the spool cap below one batch so pending+fresh always fits", () => {
    expect(SPOOL_CAP).toBeLessThan(500);
  });
});
