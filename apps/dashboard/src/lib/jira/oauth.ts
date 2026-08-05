import {
  accessibleResourcesSchema,
  atlassianTokenResponseSchema,
  type AccessibleResource,
  type AtlassianTokenResponse,
} from "@mnl-dev-telemetry/shared";

/**
 * Atlassian OAuth 2.0 (3LO) for per-user Jira links (Phase-5 brief §2/§4).
 *
 * Supersedes the spec's original shared service account: each dev authorizes in
 * their own browser and worklogs are authored as them. Constraint 3 is
 * unchanged — the *server* performs this exchange and stores the tokens
 * encrypted; nothing here ever runs on, or is sent to, a dev machine.
 *
 * Endpoints verified against
 * developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/.
 */

const AUTHORIZE_URL = "https://auth.atlassian.com/authorize";
const TOKEN_URL = "https://auth.atlassian.com/oauth/token";
const ACCESSIBLE_RESOURCES_URL =
  "https://api.atlassian.com/oauth/token/accessible-resources";

/**
 * Scopes we ask for, and why each is needed:
 *  - read:jira-work   GET /issue/{key} (estimates, key→numeric id) + search/jql
 *  - write:jira-work  POST /issue — mirror tickets only
 *  - read:jira-user   GET /myself → accountId, i.e. Tempo's authorAccountId
 *  - offline_access   refresh tokens; without it the link dies in an hour
 * Classic scopes, deliberately: the granular equivalents are still Beta.
 */
export const JIRA_OAUTH_SCOPES = [
  "read:jira-work",
  "write:jira-work",
  "read:jira-user",
  "offline_access",
] as const;

/** Refresh this many ms *before* the recorded expiry, to absorb clock skew. */
export const TOKEN_REFRESH_SKEW_MS = 60_000;

/**
 * Cookie carrying the CSRF `state` between /api/jira/connect and the callback.
 * Lives here rather than in the route: Next.js route modules may only export
 * route handlers and its own config fields, so a shared constant has to sit in
 * a lib module.
 */
export const OAUTH_STATE_COOKIE = "jira_oauth_state";

export interface OAuthAppConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** An OAuth failure we can describe to the user without leaking token material. */
export class JiraOAuthError extends Error {
  /** True when re-authorizing is the fix (grant revoked, refresh rejected). */
  readonly needsReconnect: boolean;

  constructor(message: string, opts: { needsReconnect?: boolean } = {}) {
    super(message);
    this.name = "JiraOAuthError";
    this.needsReconnect = opts.needsReconnect ?? false;
  }
}

/**
 * Read the OAuth app config from the environment. Returns null when unset, so
 * Settings can render "not configured" instead of the page throwing.
 */
export function getOAuthConfig(appUrl?: string): OAuthAppConfig | null {
  const clientId = process.env.JIRA_OAUTH_CLIENT_ID;
  const clientSecret = process.env.JIRA_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const base = (appUrl ?? process.env.APP_URL ?? "http://localhost:3000").replace(
    /\/+$/,
    "",
  );
  return { clientId, clientSecret, redirectUri: `${base}/api/jira/callback` };
}

/**
 * Build the consent URL. `state` is the CSRF binding — the caller stores the
 * same value in an httpOnly cookie and compares on callback (brief §6A).
 */
export function buildAuthorizeUrl(
  config: OAuthAppConfig,
  state: string,
): string {
  const params = new URLSearchParams({
    audience: "api.atlassian.com",
    client_id: config.clientId,
    scope: JIRA_OAUTH_SCOPES.join(" "),
    redirect_uri: config.redirectUri,
    state,
    response_type: "code",
    // `consent` (rather than the default) so a re-link always re-issues a
    // refresh token instead of silently returning an access token only.
    prompt: "consent",
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

async function postToken(
  body: Record<string, string>,
): Promise<AtlassianTokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    // Atlassian returns 400/403 with an `error` field for a revoked or
    // exhausted grant — that is a reconnect, not a retry.
    const detail = await safeErrorDetail(res);
    throw new JiraOAuthError(
      `Atlassian token endpoint returned ${res.status}${detail ? `: ${detail}` : ""}`,
      { needsReconnect: res.status === 400 || res.status === 403 },
    );
  }

  const parsed = atlassianTokenResponseSchema.safeParse(await res.json());
  if (!parsed.success) {
    throw new JiraOAuthError("Atlassian token response was not in the expected shape");
  }
  return parsed.data;
}

/** Exchange the authorization code for tokens. */
export function exchangeCodeForTokens(
  config: OAuthAppConfig,
  code: string,
): Promise<AtlassianTokenResponse> {
  return postToken({
    grant_type: "authorization_code",
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    redirect_uri: config.redirectUri,
  });
}

/**
 * Trade a refresh token for a fresh access token. Atlassian rotates refresh
 * tokens, so the caller MUST persist the returned `refresh_token` when present
 * — dropping it strands the connection at the next refresh.
 */
export function refreshAccessToken(
  config: OAuthAppConfig,
  refreshToken: string,
): Promise<AtlassianTokenResponse> {
  return postToken({
    grant_type: "refresh_token",
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: refreshToken,
  });
}

/** The Jira sites this grant can reach; `id` is the cloudId for API calls. */
export async function listAccessibleResources(
  accessToken: string,
): Promise<AccessibleResource[]> {
  const res = await fetch(ACCESSIBLE_RESOURCES_URL, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  if (!res.ok) {
    throw new JiraOAuthError(
      `accessible-resources returned ${res.status}`,
      { needsReconnect: res.status === 401 || res.status === 403 },
    );
  }
  const parsed = accessibleResourcesSchema.safeParse(await res.json());
  if (!parsed.success) {
    throw new JiraOAuthError("accessible-resources response was not in the expected shape");
  }
  return parsed.data;
}

/** Absolute expiry instant for a token response, given when the call was made. */
export function expiryFrom(
  token: AtlassianTokenResponse,
  now: Date = new Date(),
): Date {
  return new Date(now.getTime() + token.expires_in * 1000);
}

/** True when `expiresAt` is missing or within the refresh skew of `now`. */
export function isExpired(expiresAt: Date | null, now: Date = new Date()): boolean {
  if (!expiresAt) return true;
  return expiresAt.getTime() - TOKEN_REFRESH_SKEW_MS <= now.getTime();
}

/**
 * Pull a short, safe error description out of a failed response. Bounded and
 * body-shape-agnostic; never includes a token (we only ever send them, and the
 * error body echoes the grant type, not the secret).
 */
async function safeErrorDetail(res: Response): Promise<string> {
  try {
    const text = (await res.text()).slice(0, 300);
    try {
      const json = JSON.parse(text) as Record<string, unknown>;
      const code = json.error ?? json.errorMessage ?? json.message;
      return typeof code === "string" ? code : text;
    } catch {
      return text;
    }
  } catch {
    return "";
  }
}
