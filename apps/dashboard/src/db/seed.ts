import "dotenv/config";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { generateAgentToken, hashAgentToken } from "@mnl-dev-telemetry/shared";
import { pgOptions } from "./connection";
import * as schema from "./schema";

/**
 * Seed a dev user + a fresh agent token, then print the plaintext token once
 * (only the hash is stored). Idempotent on the user (by email); always issues a
 * new token so the acceptance curl always has a working credential.
 *
 * Run: `pnpm db:seed`
 */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  const email = process.env.SEED_EMAIL ?? "dev@mnl-dev-telemetry.local";
  const name = process.env.SEED_NAME ?? "Seed Dev";

  const sql = postgres(url, { ...pgOptions(url), max: 1 });
  const db = drizzle(sql, { schema, casing: "snake_case" });

  const [user] = await db
    .insert(schema.users)
    .values({ email, name, role: "dev" })
    .onConflictDoUpdate({ target: schema.users.email, set: { name } })
    .returning();

  if (!user) throw new Error("failed to upsert seed user");

  const token = generateAgentToken();
  const [tokenRow] = await db
    .insert(schema.agentTokens)
    .values({
      userId: user.id,
      tokenHash: hashAgentToken(token),
      label: `seed-${new Date().toISOString().slice(0, 10)}`,
    })
    .returning();

  await db.insert(schema.auditLog).values({
    userId: user.id,
    action: "token.issue",
    target: tokenRow?.id ?? null,
    metadata: { label: tokenRow?.label, via: "seed" },
  });

  await sql.end();

  console.log("Seeded user + agent token");
  console.log(`  user:  ${user.email} (${user.id})`);
  console.log(`  token label: ${tokenRow?.label}`);
  console.log("");
  console.log("Agent token (shown once — copy it now):");
  console.log(`  ${token}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
