import fs from "node:fs";
import path from "node:path";
import {
  deleteCredentials,
  readCredentials,
  writeCredentials,
  type Credentials,
} from "./credentials";
import { deviceLogin } from "./device-auth";
import {
  getGlobalHooksPath,
  setGlobalHooksPath,
  unsetGlobalHooksPath,
} from "./git-config";
import {
  installAgent,
  installHookScripts,
  installedHooks,
  removeHookScripts,
} from "./hooks";
import { planHooksPathInstall, planHooksPathUninstall } from "./hooks-path";
import { devpulsePaths, type DevpulsePaths } from "./paths";
import { readSpool } from "./spool";
import type { DeviceStartResponse } from "@devpulse/shared";

const DEFAULT_BASE_URL = "http://localhost:3000";

/** Path to the bundled agent.js sitting next to this cli.js in dist/. */
function defaultAgentSourcePath(): string {
  return path.join(__dirname, "agent.js");
}

function writePreviousHooksPath(paths: DevpulsePaths, value: string | null): void {
  fs.mkdirSync(paths.home, { recursive: true });
  fs.writeFileSync(paths.previousHooksPath, value ?? "");
}

function readPreviousHooksPath(paths: DevpulsePaths): string | null {
  try {
    const v = fs.readFileSync(paths.previousHooksPath, "utf8").trim();
    return v === "" ? null : v;
  } catch {
    return null;
  }
}

export interface InstallOptions {
  baseUrl?: string;
  /** Force a fresh device-auth login even if credentials already exist. */
  login?: boolean;
  label?: string;
  /**
   * Where to copy `agent.js` from. Defaults to the sibling of the running
   * bundle (`dist/agent.js`), which is right for the CLI. Embedders that ship
   * their own copy of the agent — the VS Code extension — pass its path here.
   */
  agentSourcePath?: string;
  /** Progress sink. Defaults to `console.log` (the CLI). */
  log?: (msg: string) => void;
  /** Structured device-code notification, forwarded to `deviceLogin`. */
  onCode?: (start: DeviceStartResponse) => void;
  /** Cancels an in-flight device-auth poll. */
  signal?: AbortSignal;
}

export async function runInstall(opts: InstallOptions): Promise<void> {
  const log = opts.log ?? ((msg: string) => console.log(msg));
  const paths = devpulsePaths();
  fs.mkdirSync(paths.home, { recursive: true });

  // 1. Credentials — reuse existing unless a login was explicitly requested.
  const existing = readCredentials(paths.credentials);
  const baseUrl =
    opts.baseUrl ??
    process.env.DEVPULSE_URL ??
    existing?.baseUrl ??
    DEFAULT_BASE_URL;

  let creds: Credentials | null = existing;
  if (opts.login || !existing) {
    creds = await deviceLogin({
      baseUrl,
      label: opts.label,
      log: opts.log,
      onCode: opts.onCode,
      signal: opts.signal,
    });
    writeCredentials(paths.credentials, creds);
    log(`✓ Saved credentials to ${paths.credentials} (mode 0600)`);
  } else if (existing.baseUrl !== baseUrl) {
    // URL changed without re-login: keep the token, update the URL.
    creds = { ...existing, baseUrl };
    writeCredentials(paths.credentials, creds);
  }

  // 2. Agent + hook scripts (idempotent overwrite).
  installAgent(paths, opts.agentSourcePath ?? defaultAgentSourcePath());
  installHookScripts(paths);
  log(`✓ Installed agent + hooks in ${paths.hooksDir}`);

  // 3. Global core.hooksPath, chaining any pre-existing value.
  const current = getGlobalHooksPath();
  const plan = planHooksPathInstall(current, paths.hooksDir);
  if (plan.alreadyInstalled) {
    log("✓ core.hooksPath already points at DevPulse (idempotent)");
  } else {
    if (plan.previousToStore !== undefined) {
      writePreviousHooksPath(paths, plan.previousToStore);
      if (plan.previousToStore) {
        log(`↳ Chaining pre-existing core.hooksPath: ${plan.previousToStore}`);
      }
    }
    if (plan.setHooksPath) setGlobalHooksPath(paths.hooksDir);
    log(`✓ Set global core.hooksPath → ${paths.hooksDir}`);
  }

  log("");
  log("DevPulse is set up. Commits, branch switches and pushes will now");
  log(`report metadata to ${creds?.baseUrl ?? baseUrl}`);
}

/** Breadcrumb the agent writes after every send attempt (`last-send.json`). */
export interface LastSend {
  at?: string;
  hook?: string;
  attempted?: number;
  ok?: boolean;
  spooled?: number;
  dropped?: number;
}

/**
 * Everything `status` reports, as data. `runStatus` prints it; GUI embedders
 * (the VS Code extension) render it into a status bar tooltip instead — so the
 * definition of "what is installed" lives in exactly one place.
 *
 * Note for embedders: this does a handful of sync fs reads plus one
 * `git config --global` subprocess, so call it off any latency-critical path.
 */
export interface DevpulseStatus {
  home: string;
  credentials: Credentials | null;
  /** Current global `core.hooksPath`, or null if unset. */
  hooksPath: string | null;
  /** True when `core.hooksPath` is ours — i.e. hooks actually fire. */
  hooksPathIsOurs: boolean;
  /** A pre-existing hooks path we chain to, if any. */
  chainedHooksPath: string | null;
  /** Names of the hook scripts present in `~/.devpulse/hooks/`. */
  hooks: string[];
  spoolCount: number;
  lastSend: LastSend | null;
}

export function getStatus(): DevpulseStatus {
  const paths = devpulsePaths();
  const hooksPath = getGlobalHooksPath();
  return {
    home: paths.home,
    credentials: readCredentials(paths.credentials),
    hooksPath,
    hooksPathIsOurs: hooksPath === paths.hooksDir,
    chainedHooksPath: readPreviousHooksPath(paths),
    hooks: installedHooks(paths),
    spoolCount: readSpool(paths.spool).length,
    lastSend: readJson(paths.lastSend) as LastSend | null,
  };
}

export function runStatus(): void {
  const s = getStatus();

  console.log("DevPulse status");
  console.log("  home:            ", s.home);
  if (s.credentials) {
    console.log("  logged in:        yes");
    console.log("  dashboard URL:   ", s.credentials.baseUrl);
    console.log("  token label:     ", s.credentials.label ?? "(none)");
    console.log("  token issued:    ", s.credentials.issuedAt ?? "(unknown)");
  } else {
    console.log("  logged in:        no (run `devpulse-setup login`)");
  }
  console.log(
    "  core.hooksPath:  ",
    s.hooksPath ?? "(unset)",
    s.hooksPathIsOurs ? "← DevPulse" : "",
  );
  if (s.chainedHooksPath) console.log("  chained path:    ", s.chainedHooksPath);
  console.log(
    "  hooks installed: ",
    s.hooks.length ? s.hooks.join(", ") : "(none)",
  );
  console.log("  spooled events:  ", s.spoolCount);

  if (s.lastSend) {
    console.log("  last send:       ", JSON.stringify(s.lastSend));
  } else {
    console.log("  last send:        (none yet)");
  }
}

export interface UninstallOptions {
  /** Progress sink. Defaults to `console.log` (the CLI). */
  log?: (msg: string) => void;
}

export async function runUninstall(opts: UninstallOptions = {}): Promise<void> {
  const log = opts.log ?? ((msg: string) => console.log(msg));
  const paths = devpulsePaths();

  // 1. Reverse core.hooksPath — but only if it still points at us (don't
  //    clobber a value the dev changed by hand after install).
  const current = getGlobalHooksPath();
  if (current === paths.hooksDir) {
    const { restoreTo } = planHooksPathUninstall(readPreviousHooksPath(paths));
    if (restoreTo) {
      setGlobalHooksPath(restoreTo);
      log(`✓ Restored core.hooksPath → ${restoreTo}`);
    } else {
      unsetGlobalHooksPath();
      log("✓ Unset core.hooksPath");
    }
  } else if (current) {
    log(`! core.hooksPath is ${current} (not DevPulse) — leaving it untouched`);
  }

  // 2. Remove local files.
  removeHookScripts(paths);
  for (const f of [paths.previousHooksPath, paths.spool, paths.lastSend]) {
    fs.rmSync(f, { force: true });
  }
  deleteCredentials(paths.credentials);
  log("✓ Removed hooks, agent, spool and credentials");

  // 3. Remove the home dir if now empty.
  try {
    if (fs.readdirSync(paths.home).length === 0) {
      fs.rmdirSync(paths.home);
      log(`✓ Removed ${paths.home}`);
    }
  } catch {
    /* ignore */
  }
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
