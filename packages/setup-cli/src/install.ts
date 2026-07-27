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

const DEFAULT_BASE_URL = "http://localhost:3000";

/** Path to the bundled agent.js sitting next to this cli.js in dist/. */
function agentSourcePath(): string {
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
}

export async function runInstall(opts: InstallOptions): Promise<void> {
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
    creds = await deviceLogin({ baseUrl, label: opts.label });
    writeCredentials(paths.credentials, creds);
    console.log("✓ Saved credentials to", paths.credentials, "(mode 0600)");
  } else if (existing.baseUrl !== baseUrl) {
    // URL changed without re-login: keep the token, update the URL.
    creds = { ...existing, baseUrl };
    writeCredentials(paths.credentials, creds);
  }

  // 2. Agent + hook scripts (idempotent overwrite).
  installAgent(paths, agentSourcePath());
  installHookScripts(paths);
  console.log("✓ Installed agent + hooks in", paths.hooksDir);

  // 3. Global core.hooksPath, chaining any pre-existing value.
  const current = getGlobalHooksPath();
  const plan = planHooksPathInstall(current, paths.hooksDir);
  if (plan.alreadyInstalled) {
    console.log("✓ core.hooksPath already points at DevPulse (idempotent)");
  } else {
    if (plan.previousToStore !== undefined) {
      writePreviousHooksPath(paths, plan.previousToStore);
      if (plan.previousToStore) {
        console.log(
          "↳ Chaining pre-existing core.hooksPath:",
          plan.previousToStore,
        );
      }
    }
    if (plan.setHooksPath) setGlobalHooksPath(paths.hooksDir);
    console.log("✓ Set global core.hooksPath →", paths.hooksDir);
  }

  console.log("");
  console.log("DevPulse is set up. Commits, branch switches and pushes will now");
  console.log("report metadata to", creds?.baseUrl ?? baseUrl);
}

export function runStatus(): void {
  const paths = devpulsePaths();
  const creds = readCredentials(paths.credentials);
  const current = getGlobalHooksPath();
  const hooks = installedHooks(paths);
  const prev = readPreviousHooksPath(paths);
  const spoolCount = readSpool(paths.spool).length;

  console.log("DevPulse status");
  console.log("  home:            ", paths.home);
  if (creds) {
    console.log("  logged in:        yes");
    console.log("  dashboard URL:   ", creds.baseUrl);
    console.log("  token label:     ", creds.label ?? "(none)");
    console.log("  token issued:    ", creds.issuedAt ?? "(unknown)");
  } else {
    console.log("  logged in:        no (run `devpulse-setup login`)");
  }
  console.log(
    "  core.hooksPath:  ",
    current ?? "(unset)",
    current === paths.hooksDir ? "← DevPulse" : "",
  );
  if (prev) console.log("  chained path:    ", prev);
  console.log("  hooks installed: ", hooks.length ? hooks.join(", ") : "(none)");
  console.log("  spooled events:  ", spoolCount);

  const last = readJson(paths.lastSend);
  if (last) {
    console.log("  last send:       ", JSON.stringify(last));
  } else {
    console.log("  last send:        (none yet)");
  }
}

export async function runUninstall(): Promise<void> {
  const paths = devpulsePaths();

  // 1. Reverse core.hooksPath — but only if it still points at us (don't
  //    clobber a value the dev changed by hand after install).
  const current = getGlobalHooksPath();
  if (current === paths.hooksDir) {
    const { restoreTo } = planHooksPathUninstall(readPreviousHooksPath(paths));
    if (restoreTo) {
      setGlobalHooksPath(restoreTo);
      console.log("✓ Restored core.hooksPath →", restoreTo);
    } else {
      unsetGlobalHooksPath();
      console.log("✓ Unset core.hooksPath");
    }
  } else if (current) {
    console.log(
      "! core.hooksPath is",
      current,
      "(not DevPulse) — leaving it untouched",
    );
  }

  // 2. Remove local files.
  removeHookScripts(paths);
  for (const f of [paths.previousHooksPath, paths.spool, paths.lastSend]) {
    fs.rmSync(f, { force: true });
  }
  deleteCredentials(paths.credentials);
  console.log("✓ Removed hooks, agent, spool and credentials");

  // 3. Remove the home dir if now empty.
  try {
    if (fs.readdirSync(paths.home).length === 0) {
      fs.rmdirSync(paths.home);
      console.log("✓ Removed", paths.home);
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
