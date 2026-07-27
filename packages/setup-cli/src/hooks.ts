import fs from "node:fs";
import path from "node:path";
import type { DevpulsePaths } from "./paths";
import { HOOK_NAMES, hookScript } from "./hook-scripts";

/**
 * Filesystem side of hook installation: write the shell scripts and copy the
 * bundled agent. All targets live under `~/.devpulse` — never a repo (spec §2).
 */

/** Write the three hook scripts (0755) into `~/.devpulse/hooks/`. */
export function installHookScripts(paths: DevpulsePaths): void {
  fs.mkdirSync(paths.hooksDir, { recursive: true });
  for (const name of HOOK_NAMES) {
    const file = path.join(paths.hooksDir, name);
    fs.writeFileSync(file, hookScript(name), { mode: 0o755 });
    fs.chmodSync(file, 0o755);
  }
}

/** Copy the bundled agent.js (sibling of the running CLI) to `~/.devpulse`. */
export function installAgent(paths: DevpulsePaths, agentSource: string): void {
  fs.mkdirSync(paths.home, { recursive: true });
  fs.copyFileSync(agentSource, paths.agentJs);
}

/** Remove installed hook scripts + agent (leaves credentials/spool alone). */
export function removeHookScripts(paths: DevpulsePaths): void {
  fs.rmSync(paths.hooksDir, { recursive: true, force: true });
  fs.rmSync(paths.agentJs, { force: true });
}

export function installedHooks(paths: DevpulsePaths): string[] {
  return HOOK_NAMES.filter((name) =>
    fs.existsSync(path.join(paths.hooksDir, name)),
  );
}
