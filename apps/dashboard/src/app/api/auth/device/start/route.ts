import { NextResponse } from "next/server";
import { type DeviceStartResponse } from "@devpulse/shared";
import { getDb } from "@/db";
import { deviceAuthorizations } from "@/db/schema";
import {
  DEVICE_CODE_TTL_SECONDS,
  DEVICE_POLL_INTERVAL_SECONDS,
  generateDeviceCode,
  generateUserCode,
} from "@/lib/device-codes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/device/start — begin a device-flow login (spec §4.3). No auth:
 * this only mints unclaimed codes; a token is issued only after a human
 * approves via /approve.
 */
export async function POST(): Promise<NextResponse> {
  const deviceCode = generateDeviceCode();
  const userCode = generateUserCode();
  const expiresAt = new Date(Date.now() + DEVICE_CODE_TTL_SECONDS * 1000);

  const db = getDb();
  await db.insert(deviceAuthorizations).values({
    deviceCode,
    userCode,
    status: "pending",
    expiresAt,
  });

  const appUrl = process.env.APP_URL ?? "http://localhost:3000";
  const body: DeviceStartResponse = {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: `${appUrl.replace(/\/+$/, "")}/activate`,
    interval: DEVICE_POLL_INTERVAL_SECONDS,
    expires_in: DEVICE_CODE_TTL_SECONDS,
  };
  return NextResponse.json(body, { status: 200 });
}
