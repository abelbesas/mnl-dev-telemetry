import { createHash, randomBytes } from "node:crypto";
import { AGENT_TOKEN_PREFIX } from "./config";

/**
 * Agent-token helpers (spec §5). Tokens are shown to the dev exactly once at
 * issue time; the server stores only the sha256 hash. These live in shared so
 * the setup CLI, seed script and ingestion API all hash identically.
 *
 * Node-only (uses `node:crypto`). Do not import from client-side code.
 */

/** Generate a fresh opaque agent token, e.g. `dp_<32 url-safe chars>`. */
export function generateAgentToken(): string {
  return AGENT_TOKEN_PREFIX + randomBytes(24).toString("base64url");
}

/** Hash a token for storage / lookup. */
export function hashAgentToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
