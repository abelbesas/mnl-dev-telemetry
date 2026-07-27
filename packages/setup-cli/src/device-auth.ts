import {
  deviceStartResponseSchema,
  deviceTokenResponseSchema,
  type DeviceStartResponse,
} from "@devpulse/shared";
import type { Credentials } from "./credentials";

/**
 * CLI side of the device-auth flow (spec §4.3, item 1): start → print code →
 * poll until a human approves in the dashboard, then receive the agent token.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function postJson(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => undefined);
  if (!res.ok) {
    const detail =
      json && typeof json === "object" && "error" in json
        ? String((json as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new Error(`request to ${url} failed: ${detail}`);
  }
  return json;
}

export interface DeviceLoginOptions {
  baseUrl: string;
  label?: string;
  /** Overall timeout for the whole handshake, ms. */
  timeoutMs?: number;
  log?: (msg: string) => void;
}

export async function deviceLogin(
  opts: DeviceLoginOptions,
): Promise<Credentials> {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const log = opts.log ?? ((m: string) => console.log(m));

  const startRaw = await postJson(`${baseUrl}/api/auth/device/start`, {});
  const start: DeviceStartResponse = deviceStartResponseSchema.parse(startRaw);

  log("");
  log("To connect this machine to DevPulse:");
  log(`  1. Open: ${start.verification_uri}`);
  log(`  2. Enter code: ${start.user_code}`);
  log("");
  log("Until the dashboard activate page ships (Phase 4), approve from a shell");
  log("with dashboard access:");
  log(
    `  curl -sX POST ${baseUrl}/api/auth/device/approve \\\n` +
      `    -H 'content-type: application/json' \\\n` +
      `    -d '{"user_code":"${start.user_code}","email":"you@example.com"}'`,
  );
  log("");
  log("Waiting for approval…");

  const deadline = Date.now() + (opts.timeoutMs ?? start.expires_in * 1000);
  const intervalMs = Math.max(1, start.interval) * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const raw = await postJson(`${baseUrl}/api/auth/device/token`, {
      device_code: start.device_code,
    });
    const resp = deviceTokenResponseSchema.parse(raw);

    if (resp.status === "approved") {
      if (!resp.token) {
        throw new Error(
          resp.error === "already_claimed"
            ? "this login code was already claimed; run login again"
            : "approved but no token was returned",
        );
      }
      return {
        token: resp.token,
        baseUrl,
        label: resp.token_label ?? opts.label,
        issuedAt: new Date().toISOString(),
      };
    }
    if (resp.status === "expired") {
      throw new Error("login code expired before approval; run login again");
    }
    if (resp.status === "denied") {
      throw new Error("login was denied");
    }
    // pending → keep polling
  }

  throw new Error("timed out waiting for approval");
}
