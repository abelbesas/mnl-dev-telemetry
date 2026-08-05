import { describe, expect, it, vi } from "vitest";
import {
  basicAuthTransport,
  JiraApiError,
  JiraClient,
  oauthTransport,
  originalEstimateSeconds,
  toAdf,
} from "../src/lib/jira/client";
import {
  buildAuthorizeUrl,
  expiryFrom,
  isExpired,
  JIRA_OAUTH_SCOPES,
} from "../src/lib/jira/oauth";
import { TempoApiError, TempoClient } from "../src/lib/jira/tempo";

/**
 * Adapter-level tests with mocked HTTP — no live Jira/Tempo calls in the suite
 * (brief §8). These pin the two contracts that are easy to get wrong from
 * memory: the OAuth authorize params, and Tempo v4's numeric `issueId`.
 */

/** Minimal fetch double returning a JSON body with the given status. */
function mockFetch(
  responder: (url: string, init: RequestInit) => { status?: number; body?: unknown },
) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const { status = 200, body = {} } = responder(url, init ?? {});
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("buildAuthorizeUrl", () => {
  it("sends every param Atlassian requires", () => {
    const url = new URL(
      buildAuthorizeUrl(
        {
          clientId: "cid",
          clientSecret: "secret",
          redirectUri: "http://localhost:3000/api/jira/callback",
        },
        "state-123",
      ),
    );
    expect(url.origin + url.pathname).toBe("https://auth.atlassian.com/authorize");
    expect(url.searchParams.get("audience")).toBe("api.atlassian.com");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/jira/callback",
    );
    // Never put the client secret in a URL the browser follows.
    expect(url.search).not.toContain("secret");
  });

  it("requests offline_access, without which the link dies in an hour", () => {
    expect(JIRA_OAUTH_SCOPES).toContain("offline_access");
    expect(JIRA_OAUTH_SCOPES).toContain("read:jira-work");
    expect(JIRA_OAUTH_SCOPES).toContain("read:jira-user");
    expect(JIRA_OAUTH_SCOPES).toContain("write:jira-work");
  });
});

describe("token expiry", () => {
  const now = new Date("2026-08-05T10:00:00Z");

  it("computes an absolute expiry from expires_in", () => {
    const expiry = expiryFrom({ access_token: "a", expires_in: 3600 }, now);
    expect(expiry.toISOString()).toBe("2026-08-05T11:00:00.000Z");
  });

  it("treats a missing expiry as expired", () => {
    expect(isExpired(null, now)).toBe(true);
  });

  it("refreshes slightly early, to absorb clock skew", () => {
    expect(isExpired(new Date("2026-08-05T10:00:30Z"), now)).toBe(true);
    expect(isExpired(new Date("2026-08-05T10:05:00Z"), now)).toBe(false);
  });
});

describe("JiraClient", () => {
  const transport = oauthTransport("tok", "cloud-1", "https://acme.atlassian.net");

  it("addresses the OAuth API host with the cloudId", async () => {
    let seen = "";
    const client = new JiraClient(transport, {
      fetchImpl: mockFetch((url) => {
        seen = url;
        return { body: { id: "10001", key: "WEB-101" } };
      }),
    });
    await client.getIssue("WEB-101");
    expect(seen).toContain("https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue/WEB-101");
  });

  it("uses Basic auth for the service-account transport", async () => {
    let auth = "";
    const client = new JiraClient(
      basicAuthTransport("https://acme.atlassian.net/", "bot@acme.io", "tok"),
      {
        fetchImpl: mockFetch((url, init) => {
          auth = String((init.headers as Record<string, string>).authorization);
          expect(url).toBe("https://acme.atlassian.net/rest/api/3/myself");
          return { body: { accountId: "acc-1" } };
        }),
      },
    );
    await client.myself();
    expect(auth.startsWith("Basic ")).toBe(true);
    expect(Buffer.from(auth.slice(6), "base64").toString()).toBe("bot@acme.io:tok");
  });

  it("flags a 404 so the caller can fall back to a mirror ticket", async () => {
    const client = new JiraClient(transport, {
      fetchImpl: mockFetch(() => ({ status: 404, body: {} })),
    });
    await expect(client.getIssue("CLIENT-9")).rejects.toMatchObject({
      name: "JiraApiError",
      notFound: true,
    });
  });

  it("treats 401 as reconnect but 403 as a permission problem", async () => {
    expect(new JiraApiError("x", 401).needsReconnect).toBe(true);
    // Re-authorizing wouldn't fix a permission gap, so don't ask the user to.
    expect(new JiraApiError("x", 403).needsReconnect).toBe(false);
  });

  it("times out instead of hanging a page render", async () => {
    const client = new JiraClient(transport, {
      timeoutMs: 10,
      fetchImpl: ((_i: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        })) as unknown as typeof fetch,
    });
    await expect(client.getIssue("WEB-1")).rejects.toThrow(/timed out/);
  });

  it("posts to /search/jql, not the removed /search endpoint", async () => {
    let seenUrl = "";
    let seenBody: Record<string, unknown> = {};
    const client = new JiraClient(transport, {
      fetchImpl: mockFetch((url, init) => {
        seenUrl = url;
        seenBody = JSON.parse(String(init.body));
        return { body: { issues: [{ id: "5", key: "MIR-5" }] } };
      }),
    });
    const issues = await client.searchJql('labels = "x"');
    expect(seenUrl).toContain("/rest/api/3/search/jql");
    expect(seenBody.jql).toBe('labels = "x"');
    expect(issues[0]?.key).toBe("MIR-5");
  });

  it("sends the description as ADF, which REST v3 requires", async () => {
    let body: Record<string, never> = {};
    const client = new JiraClient(transport, {
      fetchImpl: mockFetch((_url, init) => {
        body = JSON.parse(String(init.body));
        return { body: { id: "77", key: "MIR-7" } };
      }),
    });
    await client.createIssue({
      projectKey: "MIR",
      issueType: "Task",
      summary: "Mirror of CLIENT-9",
      description: "external key CLIENT-9",
      labels: ["mnl-dev-telemetry-mirror"],
    });
    const fields = (body as Record<string, Record<string, unknown>>).fields!;
    expect(fields.description).toEqual(toAdf("external key CLIENT-9"));
    expect(fields.labels).toEqual(["mnl-dev-telemetry-mirror"]);
  });
});

describe("originalEstimateSeconds", () => {
  it("reads timetracking.originalEstimateSeconds", () => {
    expect(
      originalEstimateSeconds({
        id: "1",
        key: "A-1",
        fields: { timetracking: { originalEstimateSeconds: 28_800 } },
      }),
    ).toBe(28_800);
  });

  it("falls back to the flat timeoriginalestimate field", () => {
    expect(
      originalEstimateSeconds({
        id: "1",
        key: "A-1",
        fields: { timeoriginalestimate: 3600 },
      }),
    ).toBe(3600);
  });

  it("returns null — not 0 — for a story-point ticket with no estimate", () => {
    expect(originalEstimateSeconds({ id: "1", key: "A-1", fields: {} })).toBeNull();
    expect(
      originalEstimateSeconds({
        id: "1",
        key: "A-1",
        fields: { timetracking: {}, timeoriginalestimate: null },
      }),
    ).toBeNull();
    expect(originalEstimateSeconds({ id: "1", key: "A-1" })).toBeNull();
  });
});

describe("TempoClient", () => {
  it("posts a numeric issueId — the v4 trap that v3's issueKey hides", async () => {
    let body: Record<string, unknown> = {};
    const client = new TempoClient("tempo-tok", {
      fetchImpl: mockFetch((url, init) => {
        expect(url).toBe("https://api.tempo.io/4/worklogs");
        body = JSON.parse(String(init.body));
        return {
          body: {
            tempoWorklogId: 501,
            timeSpentSeconds: 3600,
            startDate: "2026-08-05",
          },
        };
      }),
    });
    const worklog = await client.createWorklog({
      issueId: 10_001,
      authorAccountId: "acc-1",
      timeSpentSeconds: 3600,
      startDate: "2026-08-05",
      description: "work [mnl-dev-telemetry:d-1]",
    });
    expect(typeof body.issueId).toBe("number");
    expect(body.issueId).toBe(10_001);
    expect(body).not.toHaveProperty("issueKey");
    expect(worklog.tempoWorklogId).toBe(501);
  });

  it("sends the Tempo token as its own bearer, separate from Jira's", async () => {
    let auth = "";
    const client = new TempoClient("tempo-tok", {
      fetchImpl: mockFetch((_url, init) => {
        auth = String((init.headers as Record<string, string>).authorization);
        return { body: { results: [] } };
      }),
    });
    await client.searchWorklogs({ issueIds: [1], from: "2026-08-05", to: "2026-08-05" });
    expect(auth).toBe("Bearer tempo-tok");
  });

  it("scopes the idempotency probe to one issue, day and author", async () => {
    let body: Record<string, unknown> = {};
    const client = new TempoClient("t", {
      fetchImpl: mockFetch((url, init) => {
        expect(url).toContain("/4/worklogs/search");
        body = JSON.parse(String(init.body));
        return { body: { results: [] } };
      }),
    });
    await client.searchWorklogs({
      issueIds: [10_001],
      from: "2026-08-05",
      to: "2026-08-05",
      authorIds: ["acc-1"],
    });
    expect(body).toEqual({
      issueIds: [10_001],
      from: "2026-08-05",
      to: "2026-08-05",
      authorIds: ["acc-1"],
    });
  });

  it("honours a regional base URL", async () => {
    let seen = "";
    const client = new TempoClient("t", {
      baseUrl: "https://api.eu.tempo.io",
      fetchImpl: mockFetch((url) => {
        seen = url;
        return { body: { results: [] } };
      }),
    });
    await client.searchWorklogs({ issueIds: [1], from: "a", to: "b" });
    expect(seen.startsWith("https://api.eu.tempo.io/4/worklogs/search")).toBe(true);
  });

  it("marks a rejected token as needing a new one", () => {
    expect(new TempoApiError("x", 401).needsReconnect).toBe(true);
    expect(new TempoApiError("x", 500).needsReconnect).toBe(false);
  });
});
