import { describe, expect, it, vi } from "vitest";
import {
  JiraTempoAdapter,
  MIRROR_LABEL,
  SyncError,
  type MirrorStore,
} from "../src/lib/jira/adapter";
import { JiraApiError, JiraClient, oauthTransport } from "../src/lib/jira/client";
import { TempoClient } from "../src/lib/jira/tempo";
import { buildSyncTag } from "../src/lib/sync-tag";

/**
 * Sync-adapter tests with mocked HTTP (brief §8: "mock HTTP for adapter tests —
 * no live Jira calls in the test suite").
 *
 * The behaviour that matters most here is the idempotency probe: "approving a
 * draft creates exactly one Tempo worklog… running sync twice creates no
 * duplicate."
 */

const DRAFT_ID = "d1111111-2222-4333-8444-555555555555";
const ACCOUNT_ID = "acc-dev-1";

interface FakeWorklog {
  tempoWorklogId: number;
  issueId: number;
  startDate: string;
  description: string;
  timeSpentSeconds: number;
  authorAccountId: string;
}

/**
 * A stand-in for Jira + Tempo that behaves like the real pair: Tempo actually
 * stores what you post, so a second push is a genuine duplicate-creation test
 * rather than an assertion about call counts.
 */
function fakeBackend(
  opts: {
    issues?: Record<string, string>; // key -> numeric id
    estimates?: Record<string, number>;
    mirrorIssues?: Record<string, string>;
    searchResults?: { id: string; key: string }[];
    tempoFailure?: { status: number; times: number };
  } = {},
) {
  const issues = opts.issues ?? { "WEB-101": "10001" };
  const mirrorIssues = { ...(opts.mirrorIssues ?? {}) };
  const worklogs: FakeWorklog[] = [];
  const calls = { createWorklog: 0, searchWorklogs: 0, createIssue: 0, searchJql: 0 };
  let tempoFailuresLeft = opts.tempoFailure?.times ?? 0;
  let nextMirrorId = 90_001;

  const jiraFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (url.includes("/rest/api/3/search/jql")) {
      calls.searchJql++;
      return json({ issues: opts.searchResults ?? [] });
    }
    if (url.includes("/rest/api/3/issue/")) {
      const key = decodeURIComponent(url.split("/rest/api/3/issue/")[1]!.split("?")[0]!);
      const id = issues[key] ?? mirrorIssues[key];
      if (!id) return json({ errorMessages: ["Issue does not exist"] }, 404);
      return json({
        id,
        key,
        fields: {
          summary: `${key} summary`,
          timetracking:
            opts.estimates?.[key] !== undefined
              ? { originalEstimateSeconds: opts.estimates[key] }
              : {},
        },
      });
    }
    if (url.endsWith("/rest/api/3/issue") && init?.method === "POST") {
      calls.createIssue++;
      const body = JSON.parse(String(init.body)) as {
        fields: { summary: string; labels: string[] };
      };
      const id = String(nextMirrorId++);
      const key = `MIR-${calls.createIssue}`;
      mirrorIssues[key] = id;
      return json({ id, key, _summary: body.fields.summary });
    }
    return json({}, 404);
  }) as unknown as typeof fetch;

  const tempoFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (url.includes("/4/worklogs/search")) {
      calls.searchWorklogs++;
      const body = JSON.parse(String(init?.body)) as {
        issueIds: number[];
        from: string;
        to: string;
      };
      return json({
        results: worklogs.filter(
          (w) => body.issueIds.includes(w.issueId) && w.startDate === body.from,
        ),
      });
    }
    if (url.endsWith("/4/worklogs") && init?.method === "POST") {
      calls.createWorklog++;
      if (tempoFailuresLeft > 0) {
        tempoFailuresLeft--;
        return json({ errors: ["boom"] }, opts.tempoFailure!.status);
      }
      const body = JSON.parse(String(init.body)) as Omit<FakeWorklog, "tempoWorklogId">;
      const worklog: FakeWorklog = {
        ...body,
        tempoWorklogId: 500 + worklogs.length,
      };
      worklogs.push(worklog);
      return json(worklog);
    }
    return json({ results: [] });
  }) as unknown as typeof fetch;

  return { jiraFetch, tempoFetch, worklogs, calls, mirrorIssues };
}

function makeAdapter(
  backend: ReturnType<typeof fakeBackend>,
  mirror?: { store: MirrorStore },
) {
  const jira = new JiraClient(oauthTransport("tok", "cloud-1", "https://acme.atlassian.net"), {
    fetchImpl: backend.jiraFetch,
  });
  return new JiraTempoAdapter({
    jira,
    tempo: new TempoClient("tempo-tok", { fetchImpl: backend.tempoFetch }),
    authorAccountId: ACCOUNT_ID,
    mirror: mirror
      ? {
          client: jira,
          projectKey: "MIR",
          issueType: "Task",
          store: mirror.store,
        }
      : undefined,
  });
}

/** In-memory stand-in for the `mirror_links` table. */
function memoryMirrorStore(): MirrorStore & { rows: Map<string, { key: string; id: number }> } {
  const rows = new Map<string, { key: string; id: number }>();
  return {
    rows,
    async find(externalKey) {
      return rows.get(externalKey) ?? null;
    },
    async save(externalKey, internalKey, internalId) {
      rows.set(externalKey, { key: internalKey, id: internalId });
    },
  };
}

const PUSH = {
  draftId: DRAFT_ID,
  issueKey: "WEB-101",
  date: "2026-08-05",
  seconds: 5400,
  description: "WEB-101 — 2 sessions",
};

describe("resolveIssue", () => {
  it("returns the numeric id Tempo needs", async () => {
    const adapter = makeAdapter(fakeBackend());
    const resolved = await adapter.resolveIssue("WEB-101");
    expect(resolved).toEqual({ key: "WEB-101", id: 10_001, summary: "WEB-101 summary" });
  });

  it("returns null for a key that isn't on this site (the mirror cue)", async () => {
    const adapter = makeAdapter(fakeBackend());
    expect(await adapter.resolveIssue("CLIENT-9")).toBeNull();
  });

  it("surfaces a real failure rather than silently mirroring", async () => {
    const backend = fakeBackend();
    backend.jiraFetch = vi.fn(
      async () => new Response("{}", { status: 500 }),
    ) as unknown as typeof fetch;
    const adapter = makeAdapter(backend);
    await expect(adapter.resolveIssue("WEB-101")).rejects.toThrow(SyncError);
  });
});

describe("pushWorklog", () => {
  it("creates exactly one Tempo worklog, tagged with the draft id", async () => {
    const backend = fakeBackend();
    const result = await makeAdapter(backend).pushWorklog(PUSH);

    expect(backend.worklogs).toHaveLength(1);
    expect(result.deduped).toBe(false);
    expect(result.issueKey).toBe("WEB-101");
    expect(backend.worklogs[0]).toMatchObject({
      issueId: 10_001,
      timeSpentSeconds: 5400,
      startDate: "2026-08-05",
      authorAccountId: ACCOUNT_ID,
    });
    expect(backend.worklogs[0]!.description).toContain(buildSyncTag(DRAFT_ID));
  });

  it("running sync twice creates NO duplicate worklog", async () => {
    const backend = fakeBackend();
    const adapter = makeAdapter(backend);

    const first = await adapter.pushWorklog(PUSH);
    const second = await adapter.pushWorklog(PUSH);

    // The acceptance check: exactly one worklog exists in Tempo.
    expect(backend.worklogs).toHaveLength(1);
    expect(backend.calls.createWorklog).toBe(1);
    expect(second.deduped).toBe(true);
    expect(second.tempoWorklogId).toBe(first.tempoWorklogId);
  });

  it("dedupes against a worklog created by a push that timed out", async () => {
    // Simulates the dangerous case: Tempo committed, we never saw the response.
    const backend = fakeBackend();
    backend.worklogs.push({
      tempoWorklogId: 999,
      issueId: 10_001,
      startDate: "2026-08-05",
      description: `earlier attempt ${buildSyncTag(DRAFT_ID)}`,
      timeSpentSeconds: 5400,
      authorAccountId: ACCOUNT_ID,
    });

    const result = await makeAdapter(backend).pushWorklog(PUSH);
    expect(result.deduped).toBe(true);
    expect(result.tempoWorklogId).toBe("999");
    expect(backend.calls.createWorklog).toBe(0);
  });

  it("does not confuse another draft's worklog on the same issue and day", async () => {
    const backend = fakeBackend();
    backend.worklogs.push({
      tempoWorklogId: 999,
      issueId: 10_001,
      startDate: "2026-08-05",
      description: `other work ${buildSyncTag("some-other-draft")}`,
      timeSpentSeconds: 1800,
      authorAccountId: ACCOUNT_ID,
    });

    const result = await makeAdapter(backend).pushWorklog(PUSH);
    expect(result.deduped).toBe(false);
    expect(backend.worklogs).toHaveLength(2);
  });

  it("refuses to create when it cannot prove the worklog is absent", async () => {
    // If the probe fails we must NOT create — that's the double-log risk.
    const backend = fakeBackend();
    const original = backend.tempoFetch;
    backend.tempoFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/4/worklogs/search")) {
        return new Response("{}", { status: 503 });
      }
      return original(input, init);
    }) as unknown as typeof fetch;

    await expect(makeAdapter(backend).pushWorklog(PUSH)).rejects.toThrow(SyncError);
    expect(backend.calls.createWorklog).toBe(0);
  });

  it("marks a 5xx retryable and a 400 permanent", async () => {
    const transient = fakeBackend({ tempoFailure: { status: 503, times: 1 } });
    await expect(makeAdapter(transient).pushWorklog(PUSH)).rejects.toMatchObject({
      retryable: true,
    });

    const permanent = fakeBackend({ tempoFailure: { status: 400, times: 1 } });
    await expect(makeAdapter(permanent).pushWorklog(PUSH)).rejects.toMatchObject({
      retryable: false,
    });
  });
});

describe("mirror tickets", () => {
  it("creates a mirror when the key isn't resolvable, and logs against it", async () => {
    const backend = fakeBackend();
    const store = memoryMirrorStore();
    const adapter = makeAdapter(backend, { store });

    const result = await adapter.pushWorklog({ ...PUSH, issueKey: "CLIENT-9" });

    expect(backend.calls.createIssue).toBe(1);
    expect(result.issueKey).toBe("MIR-1");
    expect(store.rows.get("CLIENT-9")).toEqual({ key: "MIR-1", id: 90_001 });
    // Time landed on the mirror's numeric id, not the client key.
    expect(backend.worklogs[0]!.issueId).toBe(90_001);
  });

  it("labels the mirror and records the external key on it", async () => {
    const backend = fakeBackend();
    let body: { fields: { labels: string[]; summary: string } } | null = null;
    const original = backend.jiraFetch;
    backend.jiraFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/rest/api/3/issue") && init?.method === "POST") {
        body = JSON.parse(String(init.body));
      }
      return original(input, init);
    }) as unknown as typeof fetch;

    await makeAdapter(backend, { store: memoryMirrorStore() }).pushWorklog({
      ...PUSH,
      issueKey: "CLIENT-9",
    });
    expect(body!.fields.labels).toContain(MIRROR_LABEL);
    expect(body!.fields.summary).toContain("CLIENT-9");
  });

  it("reuses a known mirror instead of creating a second one", async () => {
    const backend = fakeBackend({ mirrorIssues: { "MIR-7": "90007" } });
    const store = memoryMirrorStore();
    await store.save("CLIENT-9", "MIR-7", 90_007);

    const result = await makeAdapter(backend, { store }).pushWorklog({
      ...PUSH,
      issueKey: "CLIENT-9",
    });
    expect(backend.calls.createIssue).toBe(0);
    expect(result.issueKey).toBe("MIR-7");
    expect(backend.worklogs[0]!.issueId).toBe(90_007);
  });

  it("recovers a mirror via JQL when the link row was lost", async () => {
    // Guards against creating a duplicate mirror after a DB reset.
    const backend = fakeBackend({
      searchResults: [{ id: "90042", key: "MIR-42" }],
      mirrorIssues: { "MIR-42": "90042" },
    });
    const store = memoryMirrorStore();

    const result = await makeAdapter(backend, { store }).pushWorklog({
      ...PUSH,
      issueKey: "CLIENT-9",
    });
    expect(backend.calls.createIssue).toBe(0);
    expect(result.issueKey).toBe("MIR-42");
    expect(store.rows.get("CLIENT-9")).toEqual({ key: "MIR-42", id: 90_042 });
  });

  it("fails with a clear message when mirroring isn't configured", async () => {
    const adapter = makeAdapter(fakeBackend()); // no mirror config
    await expect(
      adapter.pushWorklog({ ...PUSH, issueKey: "CLIENT-9" }),
    ).rejects.toMatchObject({
      name: "SyncError",
      retryable: false,
    });
    await expect(
      adapter.pushWorklog({ ...PUSH, issueKey: "CLIENT-9" }),
    ).rejects.toThrow(/mirror tickets aren't configured/);
  });

  it("still dedupes on a mirror ticket", async () => {
    const backend = fakeBackend();
    const store = memoryMirrorStore();
    const adapter = makeAdapter(backend, { store });

    await adapter.pushWorklog({ ...PUSH, issueKey: "CLIENT-9" });
    const second = await adapter.pushWorklog({ ...PUSH, issueKey: "CLIENT-9" });

    expect(backend.worklogs).toHaveLength(1);
    expect(backend.calls.createIssue).toBe(1);
    expect(second.deduped).toBe(true);
  });
});

describe("JiraApiError classification", () => {
  it("treats 404 as 'not on this instance', not as an outage", () => {
    expect(new JiraApiError("x", 404).notFound).toBe(true);
    expect(new JiraApiError("x", 500).notFound).toBe(false);
  });
});
