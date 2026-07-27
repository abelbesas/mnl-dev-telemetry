import { execFileSync } from "node:child_process";

/**
 * Thin wrappers over `git config --global core.hooksPath`. This is the ONLY git
 * setting DevPulse touches, and always at global scope so hooks apply across a
 * dev's repos without ever being committed to one (spec §2, constraint 1).
 */

function git(args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { status?: number };
    return { stdout: "", status: e.status ?? 1 };
  }
}

/** Current global `core.hooksPath`, or null if unset. */
export function getGlobalHooksPath(): string | null {
  const { stdout, status } = git([
    "config",
    "--global",
    "--get",
    "core.hooksPath",
  ]);
  if (status !== 0) return null;
  const value = stdout.trim();
  return value === "" ? null : value;
}

export function setGlobalHooksPath(value: string): void {
  git(["config", "--global", "core.hooksPath", value]);
}

export function unsetGlobalHooksPath(): void {
  // `--unset` exits 5 when the key is missing; harmless (git() swallows status).
  git(["config", "--global", "--unset", "core.hooksPath"]);
}
