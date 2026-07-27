import fs from "node:fs";
import path from "node:path";

/**
 * The agent bearer token + dashboard URL, stored at `~/.devpulse/credentials`
 * with mode 0600 (spec §4.3, item 1). Written by the CLI, read by the git hook
 * agent. Kept deliberately tiny so the hot path (agent startup) is cheap.
 */
export interface Credentials {
  token: string;
  baseUrl: string;
  label?: string;
  issuedAt?: string;
}

export function readCredentials(file: string): Credentials | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Credentials>;
    if (typeof parsed.token !== "string" || typeof parsed.baseUrl !== "string") {
      return null;
    }
    return parsed as Credentials;
  } catch {
    return null;
  }
}

export function writeCredentials(file: string, creds: Credentials): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write with restrictive mode from the outset, then chmod to be certain even
  // if the file already existed with looser permissions.
  fs.writeFileSync(file, JSON.stringify(creds, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export function deleteCredentials(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* ignore */
  }
}
