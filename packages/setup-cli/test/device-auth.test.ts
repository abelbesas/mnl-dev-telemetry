import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deviceLogin } from "../src/device-auth";

/**
 * The device flow's Phase-6 additions: a structured `onCode` callback (so a GUI
 * can render the code with an "Open activation page" button instead of parsing
 * log lines) and an `AbortSignal` (so a cancelled progress notification stops
 * the poll loop instead of leaving it running for the code's whole lifetime).
 *
 * `deviceLogin` uses global `fetch`, so it is stubbed here.
 */

const START = {
  device_code: "device-code-0123456789abcdef",
  user_code: "WDJB-MJHT",
  verification_uri: "https://dash.example/activate",
  interval: 1,
  expires_in: 600,
};

function stubFetch(
  handler: (url: string, body: unknown) => unknown,
): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body: string }) => {
      calls.push(url);
      const payload = handler(url, JSON.parse(init.body));
      return {
        ok: true,
        status: 200,
        json: async () => payload,
      } as unknown as Response;
    }),
  );
  return { calls };
}

/** Fake timers so the server-recommended 1s poll interval costs nothing. */
beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Run one poll cycle's worth of the fake clock. */
const tick = () => vi.advanceTimersByTimeAsync(START.interval * 1000 + 10);

describe("deviceLogin", () => {
  it("hands the freshly minted code to onCode before it starts polling", async () => {
    const seen: unknown[] = [];
    let polls = 0;
    stubFetch((url) => {
      if (url.endsWith("/start")) return START;
      polls++;
      // onCode must have fired before the first poll, not after approval.
      expect(seen).toHaveLength(1);
      return { status: "approved", token: "agent-token", token_label: "laptop" };
    });

    const pending = deviceLogin({
      baseUrl: "https://dash.example/",
      log: () => {},
      onCode: (start) => seen.push(start),
    });
    await tick();
    const creds = await pending;

    expect(seen).toEqual([START]);
    expect(polls).toBe(1);
    expect(creds).toMatchObject({
      token: "agent-token",
      baseUrl: "https://dash.example", // trailing slash normalised
      label: "laptop",
    });
  });

  it("stops polling when the caller aborts", async () => {
    const controller = new AbortController();
    let polls = 0;
    stubFetch((url) => {
      if (url.endsWith("/start")) {
        controller.abort(); // e.g. the user dismissed the progress notification
        return START;
      }
      polls++;
      return { status: "pending" };
    });

    const pending = deviceLogin({
      baseUrl: "https://dash.example",
      log: () => {},
      signal: controller.signal,
    });
    const rejects = expect(pending).rejects.toThrow(/cancelled/i);
    await tick();
    await rejects;
    expect(polls).toBe(0);
  });

  it("surfaces a denied approval rather than hanging", async () => {
    stubFetch((url) => (url.endsWith("/start") ? START : { status: "denied" }));
    const pending = deviceLogin({
      baseUrl: "https://dash.example",
      log: () => {},
    });
    const rejects = expect(pending).rejects.toThrow(/denied/i);
    await tick();
    await rejects;
  });

  it("explains an already-claimed code", async () => {
    stubFetch((url) =>
      url.endsWith("/start")
        ? START
        : { status: "approved", error: "already_claimed" },
    );
    const pending = deviceLogin({
      baseUrl: "https://dash.example",
      log: () => {},
    });
    const rejects = expect(pending).rejects.toThrow(/already claimed/i);
    await tick();
    await rejects;
  });
});
