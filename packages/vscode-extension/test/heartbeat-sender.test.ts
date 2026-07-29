import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createFakeVscode, type FakeVscode } from "./fake-vscode";

/**
 * Acceptance (brief §5): "editing a file produces a `heartbeat` event (source
 * `extension`) within ~5 min, carrying repo + branch and nothing else."
 *
 * The real `src/heartbeat.ts` is bundled and loaded against a stub `vscode`, so
 * this exercises the actual editor subscriptions, the actual credential read
 * from `~/.devpulse/credentials`, and the actual request the IngestClient makes.
 * `tick()` is called directly rather than waiting out the 60s timer.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);

interface SentRequest {
  url: string;
  /** Undefined-able: `noUncheckedIndexedAccess` widens header lookups. */
  authorization: string | undefined;
  body: Record<string, unknown>;
}

let bundlePath: string;
let scratch: string;
let fake: FakeVscode;
let restoreLoad: (() => void) | undefined;
let sent: SentRequest[];
let loadCount = 0;

/** A GitContext stand-in — the sender only ever asks it for the repo context. */
function fakeGit(repo: { name: string | null; branch: string | null } | null) {
  return { getRepoContext: async () => repo } as never;
}

function fakeChannel(lines: string[] = []) {
  return {
    appendLine: (l: string) => lines.push(l),
    show: () => {},
    dispose: () => {},
  } as never;
}

beforeAll(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "devpulse-hb-test-"));
  bundlePath = path.join(scratch, "heartbeat.cjs");
  await build({
    entryPoints: [path.join(here, "..", "src", "heartbeat.ts")],
    outfile: bundlePath,
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node20",
    external: ["vscode"],
    logLevel: "silent",
  });
});

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.DEVPULSE_HOME = path.join(scratch, `home-${loadCount}`);
  fs.mkdirSync(process.env.DEVPULSE_HOME, { recursive: true });

  fake = createFakeVscode();
  const load = (Module as unknown as { _load: (...a: unknown[]) => unknown })._load;
  (Module as unknown as { _load: unknown })._load = function (
    this: unknown,
    request: string,
    ...rest: unknown[]
  ) {
    if (request === "vscode") return fake;
    return load.call(this, request, ...rest);
  };
  restoreLoad = () => {
    (Module as unknown as { _load: unknown })._load = load;
  };

  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
      sent.push({
        url,
        authorization: init.headers.authorization,
        body: JSON.parse(init.body),
      });
      return {
        ok: true,
        status: 200,
        json: async () => ({ inserted: 1, skipped: 0 }),
      } as unknown as Response;
    }),
  );
});

afterEach(() => {
  restoreLoad?.();
  vi.unstubAllGlobals();
  delete process.env.DEVPULSE_HOME;
});

/** Credentials as the device flow would have written them. */
function seedCredentials(): void {
  fs.writeFileSync(
    path.join(process.env.DEVPULSE_HOME!, "credentials"),
    JSON.stringify({
      token: "dp_scratch_token",
      baseUrl: "https://dash.example",
      label: "test-machine",
    }),
    { mode: 0o600 },
  );
}

interface Sender {
  start(): void;
  stop(): void;
  readonly running: boolean;
  tick(): Promise<void>;
  dispose(): void;
}

function makeSender(opts: {
  repo?: { name: string | null; branch: string | null } | null;
  now?: () => number;
  logLines?: string[];
}): Sender {
  const copy = path.join(scratch, `heartbeat-${loadCount++}.cjs`);
  fs.copyFileSync(bundlePath, copy);
  const { HeartbeatSender } = require_(copy);
  return new HeartbeatSender(
    fakeGit(opts.repo === undefined ? { name: "acme-web", branch: "TEX-123-add-widget" } : opts.repo),
    fakeChannel(opts.logLines),
    opts.now,
  ) as Sender;
}

describe("HeartbeatSender", () => {
  it("sends a heartbeat after a real file edit", async () => {
    seedCredentials();
    const sender = makeSender({});

    // No activity yet → nothing, however many times we tick.
    await sender.tick();
    expect(sent).toHaveLength(0);

    fake.__fireDocumentChange("file");
    await sender.tick();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://dash.example/api/ingest/heartbeat");
    expect(sent[0]!.authorization).toBe("Bearer dp_scratch_token");
    sender.dispose();
  });

  it("carries repo + branch + timestamp and nothing else (spec §2)", async () => {
    seedCredentials();
    const sender = makeSender({});
    fake.__fireDocumentChange("file");
    await sender.tick();

    expect(Object.keys(sent[0]!.body).sort()).toEqual([
      "branch",
      "event_uuid",
      "repo",
      "source",
      "ts",
      "type",
    ]);
    expect(sent[0]!.body).toMatchObject({
      type: "heartbeat",
      source: "extension",
      repo: "acme-web",
      branch: "TEX-123-add-widget",
    });
    // The payload must not name a file, a path, or the token.
    const wire = JSON.stringify(sent[0]!.body);
    expect(wire).not.toContain("dp_scratch_token");
    expect(wire).not.toMatch(/\.ts|\.js|\//);
    sender.dispose();
  });

  it("counts saves and selection moves as activity too", async () => {
    seedCredentials();
    let clock = Date.parse("2026-07-29T02:00:00.000Z");
    const sender = makeSender({ now: () => clock });

    fake.__fireDocumentSave("file");
    await sender.tick();
    expect(sent).toHaveLength(1);

    clock += 6 * 60_000;
    fake.__fireSelectionChange("file");
    await sender.tick();
    expect(sent).toHaveLength(2);
    sender.dispose();
  });

  it("ignores non-file documents — our own output channel must not self-trigger", async () => {
    seedCredentials();
    const logLines: string[] = [];
    const sender = makeSender({ logLines });

    for (const scheme of ["output", "git", "vscode-userdata", "debug"]) {
      fake.__fireDocumentChange(scheme);
    }
    await sender.tick();

    expect(sent).toHaveLength(0);
    sender.dispose();
  });

  it("sends nothing when the machine is not set up", async () => {
    // No credentials written.
    const sender = makeSender({});
    fake.__fireDocumentChange("file");
    await sender.tick();

    expect(sent).toHaveLength(0);
    sender.dispose();
  });

  it("sends nothing when there is no git repo to attribute to", async () => {
    seedCredentials();
    const sender = makeSender({ repo: null });
    fake.__fireDocumentChange("file");
    await sender.tick();

    expect(sent).toHaveLength(0);
    sender.dispose();
  });

  it("stops after the idle timeout and resumes on the next edit", async () => {
    seedCredentials();
    let clock = Date.parse("2026-07-29T02:00:00.000Z");
    const sender = makeSender({ now: () => clock });

    fake.__fireDocumentChange("file");
    await sender.tick();
    expect(sent).toHaveLength(1);

    // 30 minutes of an open-but-untouched editor: one more ping lands inside the
    // idle window, then nothing.
    for (let m = 1; m <= 30; m++) {
      clock += 60_000;
      await sender.tick();
    }
    expect(sent).toHaveLength(2);

    // Dev comes back and types.
    fake.__fireDocumentChange("file");
    await sender.tick();
    expect(sent).toHaveLength(3);
    sender.dispose();
  });

  it("paces at the interval no matter how fast you type", async () => {
    seedCredentials();
    let clock = Date.parse("2026-07-29T02:00:00.000Z");
    const sender = makeSender({ now: () => clock });

    // Continuous editing for an hour, ticking every minute.
    for (let m = 0; m <= 60; m++) {
      fake.__fireDocumentChange("file");
      await sender.tick();
      clock += 60_000;
    }
    // 61 minutes at a 5-minute interval → 13 pings (t=0,5,10,…,60).
    expect(sent).toHaveLength(13);
    sender.dispose();
  });

  it("swallows a failed send and logs it, never throwing at the editor", async () => {
    seedCredentials();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const logLines: string[] = [];
    const sender = makeSender({ logLines });

    fake.__fireDocumentChange("file");
    await expect(sender.tick()).resolves.toBeUndefined();
    expect(logLines.join("\n")).toContain("heartbeat: send failed");
    sender.dispose();
  });

  it("does not retry a failed ping before the next interval", async () => {
    seedCredentials();
    let clock = Date.parse("2026-07-29T02:00:00.000Z");
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        throw new Error("network down");
      }),
    );
    const sender = makeSender({ now: () => clock, logLines: [] });

    fake.__fireDocumentChange("file");
    await sender.tick();
    clock += 60_000;
    fake.__fireDocumentChange("file");
    await sender.tick();

    // A missed ping is cheaper than a double-counted one.
    expect(calls).toBe(1);
    sender.dispose();
  });

  it("start/stop is idempotent and reflected in `running`", () => {
    const sender = makeSender({ logLines: [] });
    expect(sender.running).toBe(false);
    sender.start();
    sender.start();
    expect(sender.running).toBe(true);
    sender.stop();
    expect(sender.running).toBe(false);
    sender.dispose();
  });
});
