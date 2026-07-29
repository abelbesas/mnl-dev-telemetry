/**
 * Public surface of `@devpulse/setup` for in-process embedders.
 *
 * The CLI (`dist/cli.js`) remains the primary consumer, but Phase 6's VS Code
 * extension imports these directly and bundles them — deliberately reusing the
 * *tested* install/uninstall/status/device-auth logic rather than reimplementing
 * it or shelling out to `npx` (see docs/phase-6-extension-brief.md §4).
 *
 * Everything here is Node-only (fs, child_process) and must never import
 * `vscode` or any editor API.
 */

export {
  runInstall,
  runStatus,
  runUninstall,
  getStatus,
  type InstallOptions,
  type UninstallOptions,
  type DevpulseStatus,
  type LastSend,
} from "./install";

export { deviceLogin, type DeviceLoginOptions } from "./device-auth";

export {
  readCredentials,
  writeCredentials,
  deleteCredentials,
  type Credentials,
} from "./credentials";

export { devpulseHome, devpulsePaths, type DevpulsePaths } from "./paths";

export { getGlobalHooksPath } from "./git-config";

export { HOOK_NAMES } from "./hook-scripts";

export type { HookName } from "./event";
