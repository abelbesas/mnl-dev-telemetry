import { z } from "zod";

/**
 * Zod contracts for every **external** Jira Cloud / Tempo payload we consume
 * (CLAUDE.md: zod-validate every external payload; schemas live only here).
 *
 * These describe third-party responses, so they are deliberately permissive
 * about extra keys and strict only about the fields we actually read — a new
 * field appearing in Atlassian's response must never break a sync.
 *
 * Verified against:
 *  - developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/
 *  - developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json (REST v3)
 *  - apidocs.tempo.io/tempo-openapi.yaml (Tempo REST API v4)
 */

// --- Atlassian OAuth 2.0 (3LO) --------------------------------------------

/** Response from POST https://auth.atlassian.com/oauth/token. */
export const atlassianTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  /** Only returned when `offline_access` was granted. */
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});
export type AtlassianTokenResponse = z.infer<typeof atlassianTokenResponseSchema>;

/**
 * One entry from GET https://api.atlassian.com/oauth/token/accessible-resources.
 * `id` is the **cloudId** used to address the site's API.
 */
export const accessibleResourceSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  url: z.string().optional(),
  scopes: z.array(z.string()).optional(),
});
export const accessibleResourcesSchema = z.array(accessibleResourceSchema);
export type AccessibleResource = z.infer<typeof accessibleResourceSchema>;

// --- Jira Cloud REST v3 ---------------------------------------------------

/** GET /rest/api/3/myself — `accountId` is the Tempo worklog author id. */
export const jiraMyselfSchema = z.object({
  accountId: z.string().min(1),
  displayName: z.string().optional(),
  emailAddress: z.string().optional(),
});
export type JiraMyself = z.infer<typeof jiraMyselfSchema>;

/** `fields.timetracking` on an issue; all members are optional in practice. */
export const jiraTimeTrackingSchema = z.object({
  originalEstimateSeconds: z.number().int().nonnegative().nullish(),
  remainingEstimateSeconds: z.number().int().nonnegative().nullish(),
  timeSpentSeconds: z.number().int().nonnegative().nullish(),
});

/**
 * GET /rest/api/3/issue/{issueIdOrKey}. `id` is a **string** in Jira's JSON but
 * is a numeric id — Tempo needs it as an integer, so callers parse it.
 */
export const jiraIssueSchema = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
  fields: z
    .object({
      summary: z.string().nullish(),
      /** Seconds. Present on the issue only when time tracking is configured. */
      timeoriginalestimate: z.number().int().nonnegative().nullish(),
      timetracking: jiraTimeTrackingSchema.nullish(),
    })
    .partial()
    .passthrough()
    .optional(),
});
export type JiraIssue = z.infer<typeof jiraIssueSchema>;

/**
 * POST /rest/api/3/search/jql — the replacement for the removed
 * /rest/api/3/search (which now returns 410 Gone). Pagination is
 * `nextPageToken`-based, not `startAt`.
 */
export const jiraSearchResultsSchema = z.object({
  issues: z.array(jiraIssueSchema).default([]),
  nextPageToken: z.string().nullish(),
  isLast: z.boolean().nullish(),
});
export type JiraSearchResults = z.infer<typeof jiraSearchResultsSchema>;

/** POST /rest/api/3/issue response. */
export const jiraCreatedIssueSchema = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
  self: z.string().optional(),
});
export type JiraCreatedIssue = z.infer<typeof jiraCreatedIssueSchema>;

// --- Tempo REST API v4 ----------------------------------------------------

/**
 * A Tempo worklog. `tempoWorklogId` is the durable handle we persist on a
 * synced draft; `description` carries our idempotency tag.
 */
export const tempoWorklogSchema = z.object({
  tempoWorklogId: z.number().int(),
  timeSpentSeconds: z.number().int().nonnegative(),
  startDate: z.string(),
  description: z.string().nullish(),
  issue: z
    .object({ id: z.number().int().nullish(), self: z.string().nullish() })
    .partial()
    .passthrough()
    .nullish(),
  author: z
    .object({ accountId: z.string().nullish() })
    .partial()
    .passthrough()
    .nullish(),
});
export type TempoWorklog = z.infer<typeof tempoWorklogSchema>;

/** Paged envelope returned by GET /4/worklogs and POST /4/worklogs/search. */
export const tempoWorklogPageSchema = z.object({
  results: z.array(tempoWorklogSchema).default([]),
  metadata: z
    .object({
      count: z.number().int().nullish(),
      offset: z.number().int().nullish(),
      limit: z.number().int().nullish(),
    })
    .partial()
    .passthrough()
    .nullish(),
});
export type TempoWorklogPage = z.infer<typeof tempoWorklogPageSchema>;

/**
 * Request body for POST /4/worklogs. `issueId` is the **numeric** Jira issue id
 * — passing the alphanumeric key is the classic Tempo v4 trap (v3 took a key).
 */
export const tempoWorklogInputSchema = z.object({
  issueId: z.number().int().positive(),
  authorAccountId: z.string().min(1),
  timeSpentSeconds: z.number().int().positive(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startTime: z
    .string()
    .regex(/^([0-1]?\d|2[0-3])(:[0-5]\d)(:[0-5]\d)$/)
    .optional(),
  description: z.string().optional(),
});
export type TempoWorklogInput = z.infer<typeof tempoWorklogInputSchema>;
