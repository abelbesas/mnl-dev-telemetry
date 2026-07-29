import os from "node:os";
import path from "node:path";

/**
 * All MnlDevTelemetry client state lives under a single home directory
 * (`~/.devpulse` by default; override with `$DEVPULSE_HOME` for tests). Hooks
 * are installed here — NEVER into a repo's `.git/hooks` (spec §2, constraint 1).
 */

export function mnlDevTelemetryHome(): string {
  const override = process.env.DEVPULSE_HOME;
  if (override && override.trim() !== "") return override;
  return path.join(os.homedir(), ".devpulse");
}

export interface MnlDevTelemetryPaths {
  home: string;
  credentials: string;
  agentJs: string;
  hooksDir: string;
  previousHooksPath: string;
  spool: string;
  lastSend: string;
}

export function mnlDevTelemetryPaths(home = mnlDevTelemetryHome()): MnlDevTelemetryPaths {
  return {
    home,
    credentials: path.join(home, "credentials"),
    agentJs: path.join(home, "agent.js"),
    hooksDir: path.join(home, "hooks"),
    previousHooksPath: path.join(home, "previous-hooks-path"),
    spool: path.join(home, "spool.json"),
    lastSend: path.join(home, "last-send.json"),
  };
}
