import {
  eventBatchSchema,
  heartbeatRequestSchema,
  heartbeatResponseSchema,
  ingestResponseSchema,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type IngestEvent,
  type IngestResponse,
} from "./events";

/**
 * Minimal typed client for the ingestion API. Used by the git hooks (Phase 2),
 * the MCP server (Phase 3) and the VS Code extension's heartbeat sender
 * (Phase 6). Kept dependency-free (global `fetch`) so it can run inside a 2s
 * git-hook budget without loading heavy deps.
 */

export interface IngestClientOptions {
  /** Dashboard base URL, e.g. `https://mnl-dev-telemetry.example.com`. */
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

  /** Authenticated JSON POST with the configured timeout budget. */
  private async post(path: string, body: unknown): Promise<unknown> {
    const controller = this.timeoutMs ? new AbortController() : undefined;
    const timer =
      controller && this.timeoutMs
        ? setTimeout(() => controller.abort(), this.timeoutMs)
        : undefined;

    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
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
      return json;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Send a batch of events. Validates locally before hitting the network. */
  async sendEvents(events: IngestEvent[]): Promise<IngestResponse> {
    const body = eventBatchSchema.parse({ events });
    return ingestResponseSchema.parse(
      await this.post("/api/ingest/events", body),
    );
  }

  /**
   * Send one editor heartbeat (Phase 6 §4a). Single event, no batching — a
   * dropped ping is genuinely fine (the next one is ~5 minutes away), so unlike
   * the git hooks there is no spool behind this.
   */
  async sendHeartbeat(heartbeat: HeartbeatRequest): Promise<HeartbeatResponse> {
    const body = heartbeatRequestSchema.parse(heartbeat);
    return heartbeatResponseSchema.parse(
      await this.post("/api/ingest/heartbeat", body),
    );
  }
}
