import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { jiraConnections, users } from "@/db/schema";
import {
  deleteConnection,
  getConnectionSummary,
  getCredentials,
  markBroken,
  NoConnectionError,
  saveConnection,
  saveTempoToken,
} from "@/lib/jira/connection";

/**
 * The Phase-5 acceptance check that is a property of the stored row:
 *
 *   "Dev links their own Jira from Settings; tokens in the DB are **encrypted**
 *    (verify by eyeballing the row — no readable token)."
 *
 * Rather than eyeballing, this asserts it: the row is serialised exactly as it
 * sits in Postgres and searched for the plaintext canaries. Also covers the
 * "revoked connection surfaces reconnect, doesn't crash" check.
 *
 * Skips itself when Postgres isn't reachable.
 */

const EMAIL = "phase5-conn@test.local";

// Distinctive canaries — if any appears in the row, encryption has regressed.
const ACCESS = "ACCESS-TOKEN-PLAINTEXT-canary-11111";
const REFRESH = "REFRESH-TOKEN-PLAINTEXT-canary-22222";
const TEMPO = "TEMPO-TOKEN-PLAINTEXT-canary-33333";

let dbAvailable = false;
let userId = "";

beforeAll(async () => {
  process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 5).toString("base64");
  try {
    await getDb().execute("select 1");
    dbAvailable = true;
  } catch {
    return;
  }
  await cleanup();
  const [row] = await getDb()
    .insert(users)
    .values({ email: EMAIL, name: "Phase5 Conn" })
    .returning();
  userId = row!.id;
});

afterAll(async () => {
  if (dbAvailable) await cleanup();
});

async function cleanup(): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.email, [EMAIL]));
  if (rows.length) await db.delete(users).where(eq(users.id, rows[0]!.id));
}

const dbIt = (name: string, fn: () => Promise<void>) =>
  it(name, async () => {
    if (!dbAvailable) {
      console.warn("skipping: Postgres not reachable (run `pnpm db:up`)");
      return;
    }
    await fn();
  });

async function link(): Promise<void> {
  await saveConnection({
    userId,
    token: {
      access_token: ACCESS,
      refresh_token: REFRESH,
      expires_in: 3600,
      scope: "read:jira-work offline_access",
    },
    cloudId: "cloud-abc-123",
    siteUrl: "https://acme.atlassian.net",
    label: "Acme",
    accountId: "5b10ac8d82e05b22cc7d4ef5",
  });
  await saveTempoToken(userId, TEMPO);
}

async function rawRow(): Promise<string> {
  const [row] = await getDb()
    .select()
    .from(jiraConnections)
    .where(eq(jiraConnections.userId, userId))
    .limit(1);
  return JSON.stringify(row);
}

describe("credentials at rest (DB)", () => {
  dbIt("stores NO readable token in the row", async () => {
    await link();
    const raw = await rawRow();

    expect(raw).not.toContain(ACCESS);
    expect(raw).not.toContain(REFRESH);
    expect(raw).not.toContain(TEMPO);
    // The bundle's field names must not leak either — the row should say
    // nothing about which credentials are present.
    expect(raw).not.toMatch(/accessToken|refreshToken|apiToken/);
    // What IS there is a versioned AES-GCM envelope.
    expect(raw).toMatch(/"enc":"v1\./);
  });

  dbIt("round-trips the tokens server-side", async () => {
    const creds = await getCredentials(userId);
    expect(creds.accessToken).toBe(ACCESS);
    expect(creds.tempoApiToken).toBe(TEMPO);
    expect(creds.cloudId).toBe("cloud-abc-123");
    expect(creds.accountId).toBe("5b10ac8d82e05b22cc7d4ef5");
  });

  dbIt("exposes no secrets through the Settings-facing summary", async () => {
    const summary = await getConnectionSummary(userId);
    const raw = JSON.stringify(summary);
    expect(raw).not.toContain(ACCESS);
    expect(raw).not.toContain(REFRESH);
    expect(raw).not.toContain(TEMPO);
    expect(summary).toMatchObject({
      siteUrl: "https://acme.atlassian.net",
      status: "active",
      tempoEnabled: true,
    });
  });

  dbIt("re-linking replaces the row instead of accumulating stale tokens", async () => {
    await link();
    const rows = await getDb()
      .select()
      .from(jiraConnections)
      .where(eq(jiraConnections.userId, userId));
    expect(rows).toHaveLength(1);
  });
});

describe("connection lifecycle (DB)", () => {
  dbIt("a broken connection surfaces 'reconnect' and does not crash", async () => {
    await link();
    const linked = (await getConnectionSummary(userId))!;
    await markBroken(linked.id, "Refresh token rejected");

    const summary = await getConnectionSummary(userId);
    expect(summary!.status).toBe("broken");
    expect(summary!.statusReason).toBe("Refresh token rejected");

    // Reads throw a typed, reconnect-flagged error rather than an opaque crash.
    await expect(getCredentials(userId)).rejects.toBeInstanceOf(NoConnectionError);
    await expect(getCredentials(userId)).rejects.toMatchObject({
      needsReconnect: true,
    });
  });

  dbIt("re-linking clears the broken flag", async () => {
    await link();
    expect((await getConnectionSummary(userId))!.status).toBe("active");
  });

  dbIt("an unreadable bundle asks for a reconnect rather than half-working", async () => {
    // Simulates a rotated ENCRYPTION_KEY / corrupted row.
    await getDb()
      .update(jiraConnections)
      .set({ auth: { enc: "v1.aaaa.bbbb.cccc" } })
      .where(eq(jiraConnections.userId, userId));

    await expect(getCredentials(userId)).rejects.toMatchObject({
      name: "NoConnectionError",
      needsReconnect: true,
    });
  });

  dbIt("disconnect deletes the tokens outright", async () => {
    await link();
    expect(await deleteConnection(userId)).toBe(true);

    const rows = await getDb()
      .select()
      .from(jiraConnections)
      .where(eq(jiraConnections.userId, userId));
    expect(rows).toHaveLength(0);
    expect(await getConnectionSummary(userId)).toBeNull();

    // And a sync attempt now fails cleanly instead of throwing something odd.
    await expect(getCredentials(userId)).rejects.toBeInstanceOf(NoConnectionError);
  });
});
