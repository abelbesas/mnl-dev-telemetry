import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import {
  deviceApproveRequestSchema,
  generateAgentToken,
  hashAgentToken,
  type DeviceApproveResponse,
} from "@devpulse/shared";
import { getDb } from "@/db";
import { agentTokens, auditLog, deviceAuthorizations, users } from "@/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/device/approve — approve a pending device authorization and
 * mint an agent token for the identified user (spec §4.3).
 *
 * The caller supplies the identity here because SSO does not exist until
 * Phase 4; this route stands in for the SSO-gated dashboard "activate" page and
 * MUST be replaced by a session-derived user then. It is the only place a token
 * is created for the device flow, and it writes the `token.issue` audit row
 * (spec §5).
 */
export async function POST(req: Request): Promise<NextResponse> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = deviceApproveRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { user_code, email, name, label } = parsed.data;

  const db = getDb();
  const [grant] = await db
    .select()
    .from(deviceAuthorizations)
    .where(eq(deviceAuthorizations.userCode, user_code))
    .limit(1);

  if (!grant) {
    return NextResponse.json({ error: "unknown user_code" }, { status: 404 });
  }
  if (grant.status !== "pending") {
    return NextResponse.json(
      { error: `grant is already ${grant.status}` },
      { status: 409 },
    );
  }
  if (grant.expiresAt.getTime() <= Date.now()) {
    await db
      .update(deviceAuthorizations)
      .set({ status: "expired" })
      .where(eq(deviceAuthorizations.id, grant.id));
    return NextResponse.json({ error: "grant expired" }, { status: 410 });
  }

  // Upsert the user by email (matches the seed script's convention).
  const [user] = await db
    .insert(users)
    .values({ email, name: name ?? email, role: "dev" })
    .onConflictDoUpdate({
      target: users.email,
      set: name ? { name } : { email },
    })
    .returning();
  if (!user) {
    return NextResponse.json({ error: "failed to resolve user" }, { status: 500 });
  }

  const token = generateAgentToken();
  const tokenLabel = label ?? `cli-${new Date().toISOString().slice(0, 10)}`;
  const [tokenRow] = await db
    .insert(agentTokens)
    .values({ userId: user.id, tokenHash: hashAgentToken(token), label: tokenLabel })
    .returning();

  await db
    .update(deviceAuthorizations)
    .set({
      status: "approved",
      userId: user.id,
      tokenPlaintext: token,
      tokenLabel,
      approvedAt: new Date(),
    })
    .where(
      and(
        eq(deviceAuthorizations.id, grant.id),
        eq(deviceAuthorizations.status, "pending"),
      ),
    );

  await db.insert(auditLog).values({
    userId: user.id,
    action: "token.issue",
    target: tokenRow?.id ?? null,
    metadata: { label: tokenLabel, via: "device-auth" },
  });

  const body: DeviceApproveResponse = { ok: true, user_code };
  return NextResponse.json(body, { status: 200 });
}
