/**
 * Pure planning for `core.hooksPath` install/uninstall and chaining
 * (spec §4.3, item 2 + edge case). No filesystem or git side effects live here
 * so the branching — idempotent re-install, pre-existing husky/custom path,
 * clean reversal — is unit-testable in isolation.
 */

function normalize(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export interface HooksPathInstallPlan {
  /** True when our hooks path is already the active global one. */
  alreadyInstalled: boolean;
  /** Whether the caller should run `git config --global core.hooksPath ours`. */
  setHooksPath: boolean;
  /**
   * What to persist as the previous hooks path for later chaining/restore:
   *  - `undefined` → leave the stored value untouched (idempotent re-install)
   *  - `null`      → there was none; store an empty marker
   *  - string      → the pre-existing path to chain to and restore on uninstall
   */
  previousToStore?: string | null;
}

/**
 * Decide how to install our hooks path given the current global value.
 * Critically, a re-install where ours is already active must NOT overwrite the
 * stored previous path (that would make us chain to ourselves).
 */
export function planHooksPathInstall(
  current: string | null | undefined,
  ourPath: string,
): HooksPathInstallPlan {
  const cur = normalize(current);
  if (cur === ourPath) {
    return { alreadyInstalled: true, setHooksPath: false };
  }
  return { alreadyInstalled: false, setHooksPath: true, previousToStore: cur };
}

export interface HooksPathUninstallPlan {
  /** Path to restore, or null to unset `core.hooksPath` entirely. */
  restoreTo: string | null;
}

/** Decide how to reverse the install from the stored previous path. */
export function planHooksPathUninstall(
  stored: string | null | undefined,
): HooksPathUninstallPlan {
  return { restoreTo: normalize(stored) };
}

/**
 * Resolve the pre-existing hook to chain-call for a given hook name, or null if
 * there is none. `exists` is injected so this stays pure/testable; the shell
 * hooks perform the equivalent `[ -x ... ]` check at run time.
 */
export function resolveChainedHook(
  prevHooksPath: string | null | undefined,
  hookName: string,
  exists: (candidatePath: string) => boolean,
): string | null {
  const prev = normalize(prevHooksPath);
  if (!prev) return null;
  const sep = prev.endsWith("/") ? "" : "/";
  const candidate = `${prev}${sep}${hookName}`;
  return exists(candidate) ? candidate : null;
}
