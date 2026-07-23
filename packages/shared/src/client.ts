import {
  eventBatchSchema,
  ingestResponseSchema,
  type IngestEvent,
  type IngestResponse,
} from "./events";

/**
 * Minimal typed client for the ingestion API. Used by the git hooks (Phase 2)
 * and MCP server (Phase 3). Kept dependency-free (global `fetch`) so it can run
 * inside a 2s git-hook budget without loading heavy deps.
 */

export interface IngestClientOptions {
  /** Dashboard base URL, e.g. `https://devpulse.example.com`. */
  baseUrl: string;
  /** Agent bearer token. */
  token: string;
  /** Override fetch (tests / older runtimes). */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms. Hooks pass ~2000 (spec §2). */
  timeoutMs?: number;
}

export class IngestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "IngestError";
  }
}

export class IngestClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs?: number;

  constructor(opts: IngestClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs;
  }

  /** Send a batch of events. Validates locally before hitting the network. */
  async sendEvents(events: IngestEvent[]): Promise<IngestResponse> {
    const body = eventBatchSchema.parse({ events });

    const controller = this.timeoutMs ? new AbortController() : undefined;
    const timer =
      controller && this.timeoutMs
        ? setTimeout(() => controller.abort(), this.timeoutMs)
        : undefined;

    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/ingest/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(body),
        signal: controller?.signal,
      });

      const json = await res.json().catch(() => undefined);
      if (!res.ok) {
        throw new IngestError(
          `ingest failed with status ${res.status}`,
          res.status,
          json,
        );
      }
      return ingestResponseSchema.parse(json);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
