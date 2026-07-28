import { and, eq } from "drizzle-orm";
import { generateAgentToken, hashAgentToken } from "@devpulse/shared";
import { getDb } from "@/db";
import { agentTokens, auditLog, deviceAuthorizations } from "@/db/schema";

/**
 * Approve a pending device-auth grant for an ALREADY-AUTHENTICATED user
 * (spec §4.3 item 1 / §5). This is the Phase-4 SSO-gated replacement for the
 * Phase-2 stand-in: the identity comes from the dashboard session, never from
 * the request body, so a caller can only mint a token for *themselves*. Mints
 * the agent token (storing only its hash), parks the one-time plaintext for the
 * CLI's next poll, and writes the `token.issue` audit row.
 */

export type ApproveResult =
  | { ok: true; userCode: string; label: string }
  | { ok: false; status: number; error: string };

export async function approveDeviceForUser(opts: {
  userCode: string;
  userId: string;
  label?: string | null;
}): Promise<ApproveResult> {
  const db = getDb();
  const userCode = opts.userCode.trim().toUpperCase();
  if (!userCode) return { ok: false, status: 400, error: "Enter the code shown by the CLI." };

  const [grant] = await db
    .select()
    .from(deviceAuthorizations)
    .where(eq(deviceAuthorizations.userCode, userCode))
    .limit(1);

  if (!grant) return { ok: false, status: 404, error: "Unknown code." };
  if (grant.status !== "pending")
    return { ok: false, status: 409, error: `This code was already ${grant.status}.` };
  if (grant.expiresAt.getTime() <= Date.now()) {
    await db
      .update(deviceAuthorizations)
      .set({ status: "expired" })
      .where(eq(deviceAuthorizations.id, grant.id));
    return { ok: false, status: 410, error: "This code has expired — re-run setup." };
  }

  const token = generateAgentToken();
  const label =
    opts.label?.trim() || `cli-${new Date().toISOString().slice(0, 10)}`;

  const [tokenRow] = await db
    .insert(agentTokens)
    .values({ userId: opts.userId, tokenHash: hashAgentToken(token), label })
    .returning();

  await db
    .update(deviceAuthorizations)
    .set({
      status: "approved",
      userId: opts.userId,
      tokenPlaintext: token,
      tokenLabel: label,
      approvedAt: new Date(),
    })
    .where(
      and(
        eq(deviceAuthorizations.id, grant.id),
        eq(deviceAuthorizations.status, "pending"),
      ),
    );

  await db.insert(auditLog).values({
    userId: opts.userId,
    action: "token.issue",
    target: tokenRow?.id ?? null,
    metadata: { label, via: "device-auth" },
  });

  return { ok: true, userCode, label };
}
