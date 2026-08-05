import { and, eq, isNull } from "drizzle-orm";
import type { AtlassianTokenResponse } from "@mnl-dev-telemetry/shared";
import { getDb } from "@/db";
import { jiraConnections, type JiraConnectionRow } from "@/db/schema";
import { decryptJson, encryptJson } from "@/lib/crypto";
import {
  expiryFrom,
  getOAuthConfig,
  isExpired,
  JiraOAuthError,
  refreshAccessToken,
} from "./oauth";

/**
 * Persistence + lifecycle for per-user Jira connections.
 *
 * Everything secret lives inside one AES-256-GCM envelope in `auth` /
 * `tempo_auth` (spec §5). Decryption happens only here and only server-side;
 * callers get a short-lived access token, never the stored bundle. Nothing in
 * this module logs token material.
 */

/** The decrypted OAuth bundle. Never returned to a caller or serialized to a page. */
interface AuthBundle {
  accessToken: string;
  refreshToken?: string;
  scope?: string;
}

interface TempoBundle {
  apiToken: string;
}

/** Safe projection of a connection — no secrets, renderable in the UI. */
export interface ConnectionSummary {
  id: string;
  siteUrl: string | null;
  label: string;
  accountId: string | null;
  cloudId: string | null;
  status: "active" | "broken";
  statusReason: string | null;
  tempoEnabled: boolean;
  connectedAt: Date;
}

export function toSummary(row: JiraConnectionRow): ConnectionSummary {
  return {
    id: row.id,
    siteUrl: row.siteUrl,
    label: row.label,
    accountId: row.accountId,
    cloudId: row.cloudId,
    status: row.status,
    statusReason: row.statusReason,
    tempoEnabled: row.tempoEnabled,
    connectedAt: row.createdAt,
  };
}

function readBundle<T>(value: unknown): T | null {
  if (!value || typeof value !== "object") return null;
  const enc = (value as Record<string, unknown>).enc;
  if (typeof enc !== "string") return null;
  try {
    return decryptJson<T>(enc);
  } catch {
    // A bundle we can't decrypt (rotated ENCRYPTION_KEY, corrupted row) is
    // indistinguishable from no credential — the user must reconnect.
    return null;
  }
}

function writeBundle(value: unknown): { enc: string } {
  return { enc: encryptJson(value) };
}

// --- Reads ----------------------------------------------------------------

export async function getConnectionRow(
  userId: string,
): Promise<JiraConnectionRow | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(jiraConnections)
    .where(eq(jiraConnections.userId, userId))
    .limit(1);
  return row ?? null;
}

/** Settings-facing read: safe fields only. */
export async function getConnectionSummary(
  userId: string,
): Promise<ConnectionSummary | null> {
  const row = await getConnectionRow(userId);
  return row ? toSummary(row) : null;
}

// --- Writes ---------------------------------------------------------------

/**
 * Store (or replace) a user's connection after a successful authorization.
 * Upsert on `user_id` so re-linking updates in place rather than accumulating
 * stale rows holding old refresh tokens.
 */
export async function saveConnection(params: {
  userId: string;
  token: AtlassianTokenResponse;
  cloudId: string;
  siteUrl: string;
  label: string;
  accountId: string;
  now?: Date;
}): Promise<void> {
  const db = getDb();
  const now = params.now ?? new Date();
  const auth = writeBundle({
    accessToken: params.token.access_token,
    refreshToken: params.token.refresh_token,
    scope: params.token.scope,
  } satisfies AuthBundle);

  await db
    .insert(jiraConnections)
    .values({
      userId: params.userId,
      label: params.label,
      baseUrl: params.siteUrl,
      siteUrl: params.siteUrl,
      kind: "ours",
      auth,
      cloudId: params.cloudId,
      accountId: params.accountId,
      expiresAt: expiryFrom(params.token, now),
      status: "active",
      statusReason: null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: jiraConnections.userId,
      set: {
        label: params.label,
        baseUrl: params.siteUrl,
        siteUrl: params.siteUrl,
        auth,
        cloudId: params.cloudId,
        accountId: params.accountId,
        expiresAt: expiryFrom(params.token, now),
        status: "active",
        statusReason: null,
        updatedAt: now,
      },
    });
}

/** Remove a user's connection and every token in it (brief §6A "Disconnect"). */
export async function deleteConnection(userId: string): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .delete(jiraConnections)
    .where(eq(jiraConnections.userId, userId))
    .returning({ id: jiraConnections.id });
  return rows.length > 0;
}

/** Save a user's Tempo API token, encrypted. Enables the sync path. */
export async function saveTempoToken(
  userId: string,
  apiToken: string,
): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .update(jiraConnections)
    .set({
      tempoAuth: writeBundle({ apiToken } satisfies TempoBundle),
      tempoEnabled: true,
      updatedAt: new Date(),
    })
    .where(eq(jiraConnections.userId, userId))
    .returning({ id: jiraConnections.id });
  return rows.length > 0;
}

export async function clearTempoToken(userId: string): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .update(jiraConnections)
    .set({ tempoAuth: null, tempoEnabled: false, updatedAt: new Date() })
    .where(eq(jiraConnections.userId, userId))
    .returning({ id: jiraConnections.id });
  return rows.length > 0;
}

/** Flag a connection as needing re-authorization; surfaces "reconnect" in the UI. */
export async function markBroken(
  connectionId: string,
  reason: string,
): Promise<void> {
  const db = getDb();
  await db
    .update(jiraConnections)
    .set({ status: "broken", statusReason: reason.slice(0, 300), updatedAt: new Date() })
    .where(eq(jiraConnections.id, connectionId));
}

// --- Token access ---------------------------------------------------------

/** What the Jira/Tempo clients need, assembled per request. */
export interface ResolvedCredentials {
  connectionId: string;
  accessToken: string;
  cloudId: string;
  accountId: string;
  siteUrl: string | null;
  tempoApiToken: string | null;
}

/** Raised when there is no usable connection; callers turn it into UI state. */
export class NoConnectionError extends Error {
  readonly needsReconnect: boolean;

  constructor(message: string, needsReconnect = false) {
    super(message);
    this.name = "NoConnectionError";
    this.needsReconnect = needsReconnect;
  }
}

/**
 * Get a usable access token for `userId`, refreshing transparently when the
 * stored one is expired (or about to be). A failed refresh marks the connection
 * `broken` and throws a reconnect-flagged error rather than retrying forever
 * (brief §6A).
 */
export async function getCredentials(
  userId: string,
  now: Date = new Date(),
): Promise<ResolvedCredentials> {
  const row = await getConnectionRow(userId);
  if (!row) throw new NoConnectionError("No Jira connection — link Jira in Settings.");
  if (!row.cloudId || !row.accountId) {
    throw new NoConnectionError("Jira connection is incomplete — reconnect.", true);
  }

  const bundle = readBundle<AuthBundle>(row.auth);
  if (!bundle) {
    throw new NoConnectionError("Stored Jira credentials are unreadable — reconnect.", true);
  }

  const tempo = readBundle<TempoBundle>(row.tempoAuth);
  const base: Omit<ResolvedCredentials, "accessToken"> = {
    connectionId: row.id,
    cloudId: row.cloudId,
    accountId: row.accountId,
    siteUrl: row.siteUrl,
    tempoApiToken: tempo?.apiToken ?? null,
  };

  if (row.status === "broken") {
    throw new NoConnectionError(
      row.statusReason ?? "Jira connection needs to be reconnected.",
      true,
    );
  }

  if (!isExpired(row.expiresAt, now)) {
    return { ...base, accessToken: bundle.accessToken };
  }

  // Expired: refresh. Without a refresh token (no `offline_access` granted, or
  // an older row) there is nothing to do but reconnect.
  if (!bundle.refreshToken) {
    await markBroken(row.id, "Access token expired and no refresh token is stored.");
    throw new NoConnectionError(
      "Jira access expired and cannot be refreshed — reconnect.",
      true,
    );
  }

  const config = getOAuthConfig();
  if (!config) {
    throw new NoConnectionError(
      "Jira OAuth is not configured on the server (JIRA_OAUTH_CLIENT_ID/_SECRET).",
    );
  }

  let refreshed: AtlassianTokenResponse;
  try {
    refreshed = await refreshAccessToken(config, bundle.refreshToken);
  } catch (err) {
    const message =
      err instanceof JiraOAuthError ? err.message : "Token refresh failed.";
    // Only a definitive rejection should burn the connection; a transient
    // network blip must not force every dev to re-link.
    if (err instanceof JiraOAuthError && err.needsReconnect) {
      await markBroken(row.id, message);
      throw new NoConnectionError(`${message} Reconnect Jira in Settings.`, true);
    }
    throw new NoConnectionError(message);
  }

  const db = getDb();
  await db
    .update(jiraConnections)
    .set({
      auth: writeBundle({
        accessToken: refreshed.access_token,
        // Atlassian rotates refresh tokens — persist the new one or the next
        // refresh fails. Fall back to the old one when none is returned.
        refreshToken: refreshed.refresh_token ?? bundle.refreshToken,
        scope: refreshed.scope ?? bundle.scope,
      } satisfies AuthBundle),
      expiresAt: expiryFrom(refreshed, now),
      status: "active",
      statusReason: null,
      updatedAt: now,
    })
    .where(eq(jiraConnections.id, row.id));

  return { ...base, accessToken: refreshed.access_token };
}

// --- Org-level service account (mirror tickets only) ----------------------

/**
 * The optional shared service account from env (spec §4.6, kept as a fallback
 * per brief §2). Used ONLY to create mirror tickets in our own Jira when a
 * client project has no per-user connection. Basic auth, server-side only.
 */
export interface ServiceAccountConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
  projectKey: string;
  issueType: string;
}

export function getServiceAccount(): ServiceAccountConfig | null {
  const baseUrl = process.env.JIRA_BASE_URL;
  const email = process.env.JIRA_EMAIL;
  const apiToken = process.env.JIRA_API_TOKEN;
  const projectKey = process.env.MIRROR_PROJECT_KEY;
  if (!baseUrl || !email || !apiToken || !projectKey) return null;
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    email,
    apiToken,
    projectKey,
    issueType: process.env.MIRROR_ISSUE_TYPE || "Task",
  };
}

/** Any org-level (user_id NULL) connection rows — reserved for future use. */
export async function getOrgConnections(): Promise<JiraConnectionRow[]> {
  const db = getDb();
  return db
    .select()
    .from(jiraConnections)
    .where(and(isNull(jiraConnections.userId), eq(jiraConnections.kind, "ours")));
}
