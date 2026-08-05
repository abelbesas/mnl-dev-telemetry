import {
  tempoWorklogPageSchema,
  tempoWorklogSchema,
  type TempoWorklog,
  type TempoWorklogInput,
} from "@mnl-dev-telemetry/shared";

/**
 * Tempo REST API v4 client (spec §4.6, brief §4).
 *
 * Tempo is a **separate vendor from Atlassian**: linking Jira grants no Tempo
 * access, and this client authenticates with its own bearer token. Verified
 * against apidocs.tempo.io/tempo-openapi.yaml.
 *
 * The v4 trap this client exists to contain: `POST /4/worklogs` takes a
 * **numeric `issueId`**, not the alphanumeric issue key that v3 accepted — so
 * every push must resolve the key through Jira first.
 */

const DEFAULT_BASE_URL = "https://api.tempo.io";

export class TempoApiError extends Error {
  readonly status: number;
  /** True when the token was rejected — the dev must paste a new one. */
  readonly needsReconnect: boolean;

  constructor(message: string, status: number) {
    super(message);
    this.name = "TempoApiError";
    this.status = status;
    this.needsReconnect = status === 401;
  }
}

export interface TempoClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * Regional cluster base URL. Tempo returns an authorization error if you call
   * a cluster your data doesn't live in, so this is configurable per install
   * (https://api.eu.tempo.io | https://api.us.tempo.io | https://api.tempo.io).
   */
  baseUrl?: string;
}

export class TempoClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(token: string, opts: TempoClientOptions = {}) {
    this.token = token;
    this.baseUrl = (
      opts.baseUrl ??
      process.env.TEMPO_API_BASE_URL ??
      DEFAULT_BASE_URL
    ).replace(/\/+$/, "");
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
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method ?? "GET",
        headers: {
          authorization: `Bearer ${this.token}`,
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
      throw new TempoApiError(`Tempo request to ${path} ${reason}`, 0);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 300);
      } catch {
        /* body already consumed or unreadable — the status is enough */
      }
      throw new TempoApiError(
        `Tempo ${init.method ?? "GET"} ${path} returned ${res.status}${detail ? `: ${detail}` : ""}`,
        res.status,
      );
    }
    if (res.status === 204) return null;
    return res.json();
  }

  /**
   * POST /4/worklogs. `timeSpentSeconds` must be >= 1 and `issueId` numeric —
   * both enforced by the shared zod schema before the call goes out.
   */
  async createWorklog(input: TempoWorklogInput): Promise<TempoWorklog> {
    const parsed = tempoWorklogSchema.safeParse(
      await this.request("/4/worklogs", { method: "POST", body: input }),
    );
    if (!parsed.success) {
      throw new TempoApiError("Unexpected shape from POST /4/worklogs", 502);
    }
    return parsed.data;
  }

  /**
   * POST /4/worklogs/search — used as the idempotency probe. Scoped to one
   * issue, one day, one author, so the response stays small enough to scan for
   * our tag without paginating.
   */
  async searchWorklogs(params: {
    issueIds: number[];
    from: string;
    to: string;
    authorIds?: string[];
    limit?: number;
  }): Promise<TempoWorklog[]> {
    const limit = params.limit ?? 200;
    const parsed = tempoWorklogPageSchema.safeParse(
      await this.request(`/4/worklogs/search?limit=${limit}`, {
        method: "POST",
        body: {
          issueIds: params.issueIds,
          from: params.from,
          to: params.to,
          ...(params.authorIds ? { authorIds: params.authorIds } : {}),
        },
      }),
    );
    if (!parsed.success) {
      throw new TempoApiError("Unexpected shape from POST /4/worklogs/search", 502);
    }
    return parsed.data.results;
  }

  /** Cheap credential check for the Settings form — proves the token is live. */
  async verifyToken(): Promise<void> {
    await this.request("/4/worklogs?limit=1");
  }
}
