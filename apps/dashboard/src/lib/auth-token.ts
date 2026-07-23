import { and, eq, isNull } from "drizzle-orm";
import { hashAgentToken } from "@devpulse/shared";
import { getDb } from "@/db";
import { agentTokens, type AgentTokenRow } from "@/db/schema";

/**
 * Resolve a plaintext agent token to its (non-revoked) row and touch
 * `last_seen_at` (spec §5). Returns null when the token is unknown or revoked.
 */
export async function authenticateAgentToken(
  token: string,
): Promise<AgentTokenRow | null> {
  const db = getDb();
  const tokenHash = hashAgentToken(token);

  const [row] = await db
    .select()
    .from(agentTokens)
    .where(
      and(eq(agentTokens.tokenHash, tokenHash), isNull(agentTokens.revokedAt)),
    )
    .limit(1);

  if (!row) return null;

  await db
    .update(agentTokens)
    .set({ lastSeenAt: new Date() })
    .where(eq(agentTokens.id, row.id));

  return row;
}
