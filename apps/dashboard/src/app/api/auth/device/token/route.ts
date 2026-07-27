import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import {
  deviceTokenRequestSchema,
  type DeviceTokenResponse,
} from "@devpulse/shared";
import { getDb } from "@/db";
import { deviceAuthorizations } from "@/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/device/token — the CLI polls here with its `device_code`
 * (spec §4.3). Returns the minted token exactly once, on the first poll after
 * approval; the parked plaintext is cleared immediately after (spec §5).
 */
export async function POST(req: Request): Promise<NextResponse> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = deviceTokenRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const db = getDb();
  const [row] = await db
    .select()
    .from(deviceAuthorizations)
    .where(eq(deviceAuthorizations.deviceCode, parsed.data.device_code))
    .limit(1);

  if (!row) {
    return NextResponse.json({ error: "invalid_grant" }, { status: 400 });
  }

  // Lazily expire.
  if (row.status !== "approved" && row.expiresAt.getTime() <= Date.now()) {
    if (row.status !== "expired") {
      await db
        .update(deviceAuthorizations)
        .set({ status: "expired" })
        .where(eq(deviceAuthorizations.id, row.id));
    }
    return NextResponse.json({ status: "expired" } satisfies DeviceTokenResponse);
  }

  if (row.status === "pending") {
    return NextResponse.json({ status: "pending" } satisfies DeviceTokenResponse);
  }
  if (row.status === "denied") {
    return NextResponse.json({ status: "denied" } satisfies DeviceTokenResponse);
  }
  if (row.status === "expired") {
    return NextResponse.json({ status: "expired" } satisfies DeviceTokenResponse);
  }

  // Approved.
  if (!row.tokenPlaintext) {
    return NextResponse.json({
      status: "approved",
      error: "already_claimed",
    } satisfies DeviceTokenResponse);
  }

  const token = row.tokenPlaintext;
  const label = row.tokenLabel ?? undefined;
  // Clear the parked plaintext so it can never be read twice.
  await db
    .update(deviceAuthorizations)
    .set({ tokenPlaintext: null })
    .where(eq(deviceAuthorizations.id, row.id));

  return NextResponse.json({
    status: "approved",
    token,
    token_label: label,
  } satisfies DeviceTokenResponse);
}
