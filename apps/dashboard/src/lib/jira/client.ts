import {
  jiraCreatedIssueSchema,
  jiraIssueSchema,
  jiraMyselfSchema,
  jiraSearchResultsSchema,
  type JiraCreatedIssue,
  type JiraIssue,
  type JiraMyself,
} from "@mnl-dev-telemetry/shared";

/**
 * Thin Jira Cloud REST v3 client (spec §4.6). Only the four operations the sync
 * path needs: identify the user, resolve a key to a numeric id + estimate,
 * search for an existing mirror, and create one.
 *
 * Two transports, because two auth models exist side by side:
 *  - OAuth 3LO (per-user):  https://api.atlassian.com/ex/jira/{cloudId}/rest/...
 *  - Service account (org): https://{site}.atlassian.net/rest/... with Basic auth
 * Both are server-side only (spec §2 constraint 3).
 */

/** A Jira call that failed. `notFound` drives the mirror-ticket decision. */
export class JiraApiError extends Error {
  readonly status: number;
  readonly notFound: boolean;
  readonly needsReconnect: boolean;

  constructor(message: string, status: number) {
    super(message);
    this.name = "JiraApiError";
    this.status = status;
    this.notFound = status === 404;
    // 401 = token rejected. 403 is a permission problem on an otherwise valid
    // token, so it is NOT a reconnect — re-authorizing would change nothing.
    this.needsReconnect = status === 401;
  }
}

export interface JiraTransport {
  /** Absolute URL for a `/rest/api/3/...` path. */
  url(path: string): string;
  authHeader(): string;
  /** Human-readable site label, for error messages. */
  label: string;
}

export function oauthTransport(
  accessToken: string,
  cloudId: string,
  siteUrl?: string | null,
): JiraTransport {
  return {
    url: (path) => `https://api.atlassian.com/ex/jira/${cloudId}${path}`,
    authHeader: () => `Bearer ${accessToken}`,
    label: siteUrl ?? `cloud:${cloudId}`,
  };
}

export function basicAuthTransport(
  baseUrl: string,
  email: string,
  apiToken: string,
): JiraTransport {
  const encoded = Buffer.from(`${email}:${apiToken}`).toString("base64");
  return {
    url: (path) => `${baseUrl.replace(/\/+$/, "")}${path}`,
    authHeader: () => `Basic ${encoded}`,
    label: baseUrl,
  };
}

export interface JiraClientOptions {
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout. A hung Jira must not hang a page render. */
  timeoutMs?: number;
}

export class JiraClient {
  private readonly transport: JiraTransport;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(transport: JiraTransport, opts: JiraClientOptions = {}) {
    this.transport = transport;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  private async request(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(this.transport.url(path), {
        method: init.method ?? "GET",
        headers: {
          authorization: this.transport.authHeader(),
          accept: "application/json",
          ...(init.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });
    } catch (err) {
      const reason =
        err instanceof Error && err.name === "AbortError"
          ? `timed out after ${this.timeoutMs}ms`
          : "network error";
      // Status 0 = never reached Jira; distinguishable from a real HTTP status.
      throw new JiraApiError(`Jira request to ${path} ${reason}`, 0);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new JiraApiError(
        `Jira ${init.method ?? "GET"} ${path} returned ${res.status}${
          res.status === 404 ? " (not found on " + this.transport.label + ")" : ""
        }`,
        res.status,
      );
    }
    if (res.status === 204) return null;
    return res.json();
  }

  /** GET /rest/api/3/myself — the accountId Tempo needs as worklog author. */
  async myself(): Promise<JiraMyself> {
    const parsed = jiraMyselfSchema.safeParse(await this.request("/rest/api/3/myself"));
    if (!parsed.success) {
      throw new JiraApiError("Unexpected shape from /myself", 502);
    }
    return parsed.data;
  }

  /**
   * GET /rest/api/3/issue/{key}. Throws `JiraApiError` with `notFound` when the
   * key doesn't exist on this site — the signal to fall back to a mirror ticket.
   */
  async getIssue(issueKey: string): Promise<JiraIssue> {
    const fields = ["summary", "timetracking", "timeoriginalestimate"].join(",");
    const parsed = jiraIssueSchema.safeParse(
      await this.request(
        `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=${fields}`,
      ),
    );
    if (!parsed.success) {
      throw new JiraApiError(`Unexpected shape from /issue/${issueKey}`, 502);
    }
    return parsed.data;
  }

  /**
   * POST /rest/api/3/search/jql — the replacement for /rest/api/3/search, which
   * Atlassian removed (it now returns 410 Gone). Single page only: our callers
   * look up one mirror ticket, never enumerate a backlog.
   */
  async searchJql(jql: string, maxResults = 5): Promise<JiraIssue[]> {
    const parsed = jiraSearchResultsSchema.safeParse(
      await this.request("/rest/api/3/search/jql", {
        method: "POST",
        body: { jql, maxResults, fields: ["summary"] },
      }),
    );
    if (!parsed.success) {
      throw new JiraApiError("Unexpected shape from /search/jql", 502);
    }
    return parsed.data.issues;
  }

  /** POST /rest/api/3/issue. `description` is ADF in REST v3, not plain text. */
  async createIssue(input: {
    projectKey: string;
    issueType: string;
    summary: string;
    description?: string;
    labels?: string[];
  }): Promise<JiraCreatedIssue> {
    const parsed = jiraCreatedIssueSchema.safeParse(
      await this.request("/rest/api/3/issue", {
        method: "POST",
        body: {
          fields: {
            project: { key: input.projectKey },
            issuetype: { name: input.issueType },
            summary: input.summary,
            labels: input.labels ?? [],
            ...(input.description
              ? { description: toAdf(input.description) }
              : {}),
          },
        },
      }),
    );
    if (!parsed.success) {
      throw new JiraApiError("Unexpected shape from POST /issue", 502);
    }
    return parsed.data;
  }
}

/** Minimal Atlassian Document Format wrapper — REST v3 rejects a bare string. */
export function toAdf(text: string): unknown {
  return {
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

/**
 * The original estimate in seconds, or null when the ticket has none.
 *
 * Returns null (not 0) for an absent/zero estimate on purpose: many teams
 * estimate in story points, a per-instance custom field we deliberately don't
 * read (brief §6B/§7). "No estimate" must stay distinguishable from "estimated
 * at zero", or Task detail computes a nonsense compression ratio.
 */
export function originalEstimateSeconds(issue: JiraIssue): number | null {
  const fields = issue.fields;
  const fromTimeTracking = fields?.timetracking?.originalEstimateSeconds;
  const fromField = fields?.timeoriginalestimate;
  const value =
    typeof fromTimeTracking === "number" && fromTimeTracking > 0
      ? fromTimeTracking
      : typeof fromField === "number" && fromField > 0
        ? fromField
        : null;
  return value;
}
