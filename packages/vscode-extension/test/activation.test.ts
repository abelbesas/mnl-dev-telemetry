import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { runInstall } from "@mnl-dev-telemetry/setup";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFakeVscode, type FakeVscode } from "./fake-vscode";

/**
 * Acceptance (brief §6): "extension host never blocks >100ms on activation
 * (lazy-init; no sync fs/git at startup beyond a stat)".
 *
 * We bundle the real `src/extension.ts` the same way the VSIX does, load it with
 * a stub `vscode` module, and drive `activate()`. That covers the wiring the
 * pure-logic tests can't: activation latency, what the status bar ends up
 * saying, and the first-run notification.
 *
 * `DEVPULSE_HOME` / `GIT_CONFIG_GLOBAL` are pointed at a scratch dir so nothing
 * here reads or writes the developer's real MnlDevTelemetry install or git config.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);

let bundlePath: string;
let scratch: string;
let restoreLoad: (() => void) | undefined;
let fake: FakeVscode;

interface FakeContext {
  extensionPath: string;
  subscriptions: Array<{ dispose(): void }>;
  globalState: {
    get: (key: string) => unknown;
    update: (key: string, value: unknown) => Promise<void>;
  };
}

function fakeContext(store = new Map<string, unknown>()): FakeContext {
  return {
    extensionPath: path.join(here, ".."),
    subscriptions: [],
    globalState: {
      get: (key) => store.get(key),
      update: async (key, value) => void store.set(key, value),
    },
  };
}

/** Let the deferred `start()` (setTimeout 0) and its awaits settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 5));
}

beforeAll(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mnl-dev-telemetry-vsix-test-"));
  bundlePath = path.join(scratch, "extension.cjs");
  await build({
    entryPoints: [path.join(here, "..", "src", "extension.ts")],
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
  process.env.DEVPULSE_HOME = path.join(scratch, "home");
  // A path that does not exist → `git config --global --get` finds nothing,
  // which is exactly the fresh-machine state. Both are cleared per test so the
  // suite never depends on execution order (and never touches the real ones).
  process.env.GIT_CONFIG_GLOBAL = path.join(scratch, "scratch-gitconfig");
  fs.rmSync(process.env.DEVPULSE_HOME, { recursive: true, force: true });
  fs.rmSync(process.env.GIT_CONFIG_GLOBAL, { force: true });

  fake = createFakeVscode({ dashboardUrl: "https://dash.example" });
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
});

afterEach(() => {
  restoreLoad?.();
  delete process.env.DEVPULSE_HOME;
  delete process.env.GIT_CONFIG_GLOBAL;
});

/**
 * The bundle captures `require("vscode")` once at module load, so each test
 * needs its own module instance bound to its own fake host. Copying the bundle
 * to a fresh filename is the least fragile way to get one (poking at
 * `require.cache` is unreliable under vitest's module runner).
 */
let loadCount = 0;
function loadExtension(): {
  activate: (ctx: FakeContext) => void;
  deactivate: () => void;
} {
  const copy = path.join(scratch, `extension-${loadCount++}.cjs`);
  fs.copyFileSync(bundlePath, copy);
  return require_(copy);
}

describe("activation", () => {
  it("returns well inside the 100ms budget and does no fs/git work", () => {
    const ext = loadExtension();
    const ctx = fakeContext();

    const started = process.hrtime.bigint();
    ext.activate(ctx);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    // Measured at ~0.35ms locally; the assertion is the acceptance threshold.
    expect(elapsedMs).toBeLessThan(100);
    // Nothing has touched ~/.devpulse yet — state detection is deferred.
    expect(fs.existsSync(path.join(scratch, "home"))).toBe(false);
    expect(fake.__statusBar[0]?.text).toBe("$(pulse) MnlDevTelemetry");
  });

  it("shows the status bar item and registers every command", () => {
    const ext = loadExtension();
    ext.activate(fakeContext());

    expect(fake.__statusBar).toHaveLength(1);
    expect(fake.__statusBar[0]?.shown).toBe(true);
    expect([...fake.__commands.keys()].sort()).toEqual([
      "mnlDevTelemetry.enable",
      "mnlDevTelemetry.openCurrentTask",
      "mnlDevTelemetry.openDashboard",
      "mnlDevTelemetry.status",
      "mnlDevTelemetry.uninstall",
    ]);
  });

  it("settles into the not-installed state and offers first-run setup", async () => {
    const ext = loadExtension();
    ext.activate(fakeContext());
    await settle();

    expect(fake.__statusBar[0]?.text).toBe("$(pulse) MnlDevTelemetry: Set up");
    expect(fake.__statusBar[0]?.command).toBe("mnlDevTelemetry.enable");
    const welcome = fake.__messages.find((m) => /Enable MnlDevTelemetry/.test(m.message));
    expect(welcome?.items).toContain("Enable MnlDevTelemetry");
  });

  it("respects a dismissed welcome notification", async () => {
    const store = new Map<string, unknown>([["mnlDevTelemetry.welcomeDismissed", true]]);
    const ext = loadExtension();
    ext.activate(fakeContext(store));
    await settle();

    expect(fake.__messages).toHaveLength(0);
    // Status bar still updates — only the nagging is suppressed.
    expect(fake.__statusBar[0]?.text).toBe("$(pulse) MnlDevTelemetry: Set up");
  });

  it("opens the configured dashboard from the palette command", async () => {
    const ext = loadExtension();
    ext.activate(fakeContext(new Map([["mnlDevTelemetry.welcomeDismissed", true]])));
    await settle();

    await fake.__commands.get("mnlDevTelemetry.openDashboard")?.();
    expect(fake.__opened).toEqual(["https://dash.example/timeline"]);
  });

  it("explains the missing issue key instead of opening a bogus task URL", async () => {
    const ext = loadExtension();
    ext.activate(fakeContext(new Map([["mnlDevTelemetry.welcomeDismissed", true]])));
    await settle();

    await fake.__commands.get("mnlDevTelemetry.openCurrentTask")?.();
    expect(fake.__opened).toEqual([]);
    expect(fake.__messages.some((m) => /No git repository/.test(m.message))).toBe(
      true,
    );
  });

  it("leaves heartbeats off on a machine that is not set up (§4a: no nagging)", async () => {
    const ext = loadExtension();
    ext.activate(fakeContext(new Map([["mnlDevTelemetry.welcomeDismissed", true]])));
    await settle();

    await fake.__commands.get("mnlDevTelemetry.status")?.();
    expect(fake.__output.join("\n")).toContain("heartbeat:        off");
  });

  it("disposes cleanly", async () => {
    const ext = loadExtension();
    const ctx = fakeContext();
    ext.activate(ctx);
    await settle();

    for (const d of ctx.subscriptions) d.dispose();
    ext.deactivate();
    expect(fake.__statusBar[0]?.disposed).toBe(true);
  });
});

/**
 * Acceptance (brief §6): "status bar shows the issue key on a `TEX-123-*` branch
 * and the nudge state on `main`". Here the extension is genuinely installed into
 * a scratch `DEVPULSE_HOME` and pointed at a scratch git repo, with no
 * `vscode.git` extension available — so this also covers the `git rev-parse`
 * fallback path.
 */
describe("an installed machine, in a repo", () => {
  let repo: string;

  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, stdio: "ignore" });

  beforeEach(async () => {
    const home = process.env.DEVPULSE_HOME!;
    repo = fs.mkdtempSync(path.join(scratch, "repo-"));
    git("init", "--quiet", "-b", "TEX-123-add-widget");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    fs.writeFileSync(path.join(repo, "README.md"), "scratch\n");
    git("add", "-A");
    git("commit", "--quiet", "-m", "initial");

    // A real install, minus the device-auth round trip: seed the credentials the
    // device flow would have written, then let runInstall do the rest.
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      path.join(home, "credentials"),
      JSON.stringify({
        token: "scratch-token",
        baseUrl: "https://dash.example",
        label: "test-machine",
      }),
      { mode: 0o600 },
    );
    const stubAgent = path.join(scratch, "stub-agent.js");
    fs.writeFileSync(stubAgent, "// stub\n");
    await runInstall({
      baseUrl: "https://dash.example",
      agentSourcePath: stubAgent,
      log: () => {},
    });

    fake.workspace.workspaceFolders = [
      { uri: (fake.Uri.file as (p: string) => unknown)(repo) },
    ];
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(process.env.DEVPULSE_HOME!, { recursive: true, force: true });
  });

  it("shows the issue key from the branch and links to that task", async () => {
    const ext = loadExtension();
    ext.activate(fakeContext());
    await settle();

    expect(fake.__statusBar[0]?.text).toBe("$(pulse) TEX-123");
    expect(fake.__statusBar[0]?.backgroundColor).toBeUndefined();
    // Active install → no first-run nagging.
    expect(fake.__messages).toHaveLength(0);

    await fake.__commands.get("mnlDevTelemetry.openCurrentTask")?.();
    expect(fake.__opened).toEqual(["https://dash.example/tasks/TEX-123"]);
  });

  it("nudges on a keyless branch, and updates on branch switch", async () => {
    const ext = loadExtension();
    ext.activate(fakeContext());
    await settle();
    expect(fake.__statusBar[0]?.text).toBe("$(pulse) TEX-123");

    git("checkout", "--quiet", "-b", "main");
    // Re-checking state is what a git event (or the focus/interval tick) drives.
    await fake.__commands.get("mnlDevTelemetry.status")?.();

    expect(fake.__statusBar[0]?.text).toBe("$(pulse) MnlDevTelemetry: no ticket");
    expect(fake.__statusBar[0]?.backgroundColor).toEqual({
      id: "statusBarItem.warningBackground",
    });
    expect(fake.__statusBar[0]?.tooltip?.value).toContain(
      "TEX-123-short-description",
    );
  });

  it("reports the install in the output channel, without the token", async () => {
    const ext = loadExtension();
    ext.activate(fakeContext());
    await settle();

    await fake.__commands.get("mnlDevTelemetry.status")?.();
    const text = fake.__output.join("\n");
    expect(text).toContain("state:            active");
    expect(text).toContain("post-commit, post-checkout, pre-push");
    expect(text).toContain("← MnlDevTelemetry");
    expect(text).not.toContain("scratch-token");
  });

  it("starts heartbeats once state detection says active (§4a)", async () => {
    const ext = loadExtension();
    ext.activate(fakeContext());
    await settle();

    await fake.__commands.get("mnlDevTelemetry.status")?.();
    expect(fake.__output.join("\n")).toMatch(
      /heartbeat: {8}on — every 5 min while editing, stops after 5 min idle/,
    );
    // And the tooltip discloses it, so a dev can see what is being sent.
    expect(fake.__statusBar[0]?.tooltip?.value).toContain("Heartbeat: every 5 min");
  });
});

/**
 * Acceptance (brief §6): "uninstall from the palette restores prior
 * `core.hooksPath` (parity with CLI uninstall) and flips the status bar back to
 * 'Set up'".
 */
describe("uninstall from the palette", () => {
  const PRIOR_HOOKS_PATH = "/tmp/pre-existing-hooks";

  beforeEach(async () => {
    const home = process.env.DEVPULSE_HOME!;
    // A dev who already had a global hooks path (husky, custom) before MnlDevTelemetry.
    fs.writeFileSync(
      process.env.GIT_CONFIG_GLOBAL!,
      `[core]\n\thooksPath = ${PRIOR_HOOKS_PATH}\n`,
    );

    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      path.join(home, "credentials"),
      JSON.stringify({ token: "t", baseUrl: "https://dash.example" }),
      { mode: 0o600 },
    );
    const stubAgent = path.join(scratch, "stub-agent.js");
    fs.writeFileSync(stubAgent, "// stub\n");
    await runInstall({
      baseUrl: "https://dash.example",
      agentSourcePath: stubAgent,
      log: () => {},
    });
  });

  it("restores the prior hooks path and flips the status bar back", async () => {
    const home = process.env.DEVPULSE_HOME!;
    const ext = loadExtension();
    ext.activate(fakeContext());
    await settle();
    expect(fake.__statusBar[0]?.text).not.toBe("$(pulse) MnlDevTelemetry: Set up");

    fake.__answer(/Remove MnlDevTelemetry/, "Uninstall");
    await fake.__commands.get("mnlDevTelemetry.uninstall")?.();

    expect(fs.readFileSync(process.env.GIT_CONFIG_GLOBAL!, "utf8")).toContain(
      PRIOR_HOOKS_PATH,
    );
    expect(fs.existsSync(path.join(home, "credentials"))).toBe(false);
    expect(fs.existsSync(path.join(home, "hooks"))).toBe(false);
    expect(fake.__statusBar[0]?.text).toBe("$(pulse) MnlDevTelemetry: Set up");

    // Uninstalling must also silence heartbeats, not just the status bar.
    fake.__output.length = 0;
    await fake.__commands.get("mnlDevTelemetry.status")?.();
    expect(fake.__output.join("\n")).toContain("heartbeat:        off");
  });

  it("does nothing when the confirmation is dismissed", async () => {
    const home = process.env.DEVPULSE_HOME!;
    const ext = loadExtension();
    ext.activate(fakeContext());
    await settle();

    // No __answer registered → the modal resolves to undefined (Cancel).
    await fake.__commands.get("mnlDevTelemetry.uninstall")?.();

    expect(fs.existsSync(path.join(home, "credentials"))).toBe(true);
    expect(fs.readFileSync(process.env.GIT_CONFIG_GLOBAL!, "utf8")).toContain(
      "hooks",
    );
  });
});
