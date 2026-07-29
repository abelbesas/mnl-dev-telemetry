import { HOOK_NAMES, type MnlDevTelemetryStatus } from "@mnl-dev-telemetry/setup";

/**
 * "Is MnlDevTelemetry actually working on this machine?" — derived from the same
 * `getStatus()` the CLI prints, so the extension and `mnl-dev-telemetry-setup status`
 * can never disagree.
 *
 * Pure (no `vscode`, no fs): the facts are extracted once, the verdict is a
 * function of them.
 */

export type SetupState =
  /** No credentials and no hooks — the first-run case. */
  | "not-installed"
  /**
   * Half-installed: a token but no active hooks (or vice versa). Happens when
   * something else took over global `core.hooksPath`, or an install was
   * interrupted. Re-running Enable is idempotent and repairs it.
   */
  | "partial"
  /** Token present and our hooks are the active global hooks path. */
  | "active";

/** The minimum set of facts the verdict depends on. */
export interface StateFacts {
  hasCredentials: boolean;
  /** Global `core.hooksPath` points at `~/.devpulse/hooks`. */
  hooksPathIsOurs: boolean;
  /** All three hook scripts are present on disk. */
  hookScriptsPresent: boolean;
}

export function factsFromStatus(status: MnlDevTelemetryStatus): StateFacts {
  return {
    hasCredentials: status.credentials !== null,
    hooksPathIsOurs: status.hooksPathIsOurs,
    hookScriptsPresent: HOOK_NAMES.every((h) => status.hooks.includes(h)),
  };
}

export function deriveSetupState(facts: StateFacts): SetupState {
  const hooksLive = facts.hooksPathIsOurs && facts.hookScriptsPresent;
  if (facts.hasCredentials && hooksLive) return "active";
  if (facts.hasCredentials || hooksLive) return "partial";
  return "not-installed";
}

/** Convenience for the common path: status → state. */
export function setupStateFromStatus(status: MnlDevTelemetryStatus): SetupState {
  return deriveSetupState(factsFromStatus(status));
}

/**
 * Why a `partial` install is partial, as a one-line human explanation. Returns
 * null for any other state.
 */
export function partialReason(status: MnlDevTelemetryStatus): string | null {
  if (setupStateFromStatus(status) !== "partial") return null;
  const facts = factsFromStatus(status);
  if (!facts.hasCredentials) {
    return "Git hooks are installed but this machine has no agent token yet.";
  }
  if (!facts.hookScriptsPresent) {
    return "You have an agent token, but the git hook scripts are missing.";
  }
  return status.hooksPath
    ? `You have an agent token, but global core.hooksPath points at ${status.hooksPath} instead of MnlDevTelemetry.`
    : "You have an agent token, but global core.hooksPath is not set to MnlDevTelemetry.";
}
