# Phase 5 — Jira connection, drafts, one-click Tempo sync

> Self-contained brief for a fresh Claude Code session. Kickoff prompt is in §9.
> Also skim `docs/phase-4-notes.md` (sessions/dashboard) — this phase consumes
> `task_sessions` and writes `worklog_drafts`.

## 1. Goal

Close the loop. Today the tool *measures* time per ticket; it doesn't put it
anywhere. After this phase:

1. A dev **links their own Jira** from Settings (OAuth, no tokens pasted).
2. Task detail shows the **real estimate pulled from Jira**, not a manual field.
3. Nightly, sessions roll up into **worklog drafts** (per ticket, per day).
4. The dev reviews the Drafts screen and **one-click approves** → the worklog
   lands in Tempo, authored as them.

Human approval stays mandatory. No silent auto-logging (spec §2.5).

## 2. IMPORTANT — a deliberate change from the original spec

The original §4.6 assumed **one shared service account** in env vars
(`JIRA_EMAIL` / `JIRA_API_TOKEN` / `TEMPO_API_TOKEN`). That is **superseded**:
this phase implements **per-user OAuth 2.0 (3LO)** so each dev links their own
Jira and worklogs are authored as themselves, not as a robot.

Why it matters: a shared service account would log everyone's time as one
account, which Tempo timesheets and approvals are not designed around, and it
needs an admin to provision it before anyone can try the feature.

**Constraint 3 still holds and must not be weakened.** Tokens live
**encrypted, server-side only**, never reach a dev machine, and never go into an
agent token's scope. The dev authorizes in a browser; the token is stored by the
server.

Keep the env-var service account as an **optional fallback**, used only for
creating mirror tickets in our Jira when a client project has no connection.

## 3. What already exists

- `jira_connections` table: `id, label, base_url, kind ('ours'|'client'), auth
  jsonb, tempo_enabled`. **No `user_id`** — it was modelled org-level. Per-user
  OAuth needs one (see §5).
- `mirror_links` table: `internal_issue_key, external_issue_key,
  jira_connection_id`.
- `worklog_drafts` table: `user_id, issue_key, date, seconds, description,
  session_ids, status ('draft'|'approved'|'synced'|'dismissed'), approved_at,
  synced_at, tempo_worklog_id`. Created in Phase 1, **never used yet** — this
  phase is its first consumer.
- `task_estimates` table (Phase 4): manual per-ticket estimate in seconds,
  unique on `issue_key`. Jira-sourced estimates should flow into the same place
  so Task detail doesn't need two code paths — add a `source` column
  (`'manual' | 'jira'`) rather than a second table.
- `task_sessions` with `reported_seconds` (working-hours-clamped) — the number
  that becomes a worklog.
- `audit_log` — spec §5 requires rows on draft approval and sync push.
- Dashboard patterns to copy: server actions + `useActionState` client forms,
  toasts (`useToastOnResult`), own-data enforcement in `lib/queries.ts`.

## 4. API facts (verified — but re-check during implementation)

CLAUDE.md rule: verify current docs, don't trust memory. Verified at time of
writing:

**Jira Cloud OAuth 2.0 (3LO)**
- Authorize: `https://auth.atlassian.com/authorize` → token exchange at
  `https://auth.atlassian.com/oauth/token` (authorization code + refresh token;
  request `offline_access` or the connection dies in an hour).
- After token: `GET https://api.atlassian.com/oauth/token/accessible-resources`
  → the **cloudId** for the site the user granted.
- API calls: `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/...`
- Scopes needed: read issues (`read:jira-work`), read the user
  (`read:jira-user`) to get their `accountId`, plus `offline_access`.
- Estimate lives in `fields.timetracking.originalEstimateSeconds` /
  `fields.timeoriginalestimate` (seconds).

**Tempo (separate vendor — this is the trap)**
- `POST https://api.tempo.io/4/worklogs` with **`issueId` (integer, NOT the
  issue key)**, `authorAccountId`, `timeSpentSeconds`, `startDate`,
  `description`.
- So every push needs a **key → numeric id** resolution via the Jira API first.
- **Tempo auth is NOT Jira auth.** Linking Jira does *not* grant Tempo access.
  Tempo offers per-user API tokens (scoped view/manage) or an OAuth 2.0 app that
  a Tempo admin must register. Decide early:
  - *Simplest:* dev pastes a **Tempo personal API token** in Settings (stored
    encrypted server-side — still satisfies constraint 3).
  - *Nicer, needs admin:* register a Tempo OAuth app and do a second link flow.
  Pick one, write down why in the notes. Don't silently assume Jira OAuth covers
  Tempo — it doesn't.

Sources to re-verify: `developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/`,
`apidocs.tempo.io`, `help.tempo.io`.

## 5. Schema changes needed

- `jira_connections`: add `user_id` (nullable — null = org-level/service
  account), `cloud_id`, `account_id`, `site_url`, `expires_at`. Keep `auth`
  jsonb for the encrypted token bundle.
- **Encryption at rest is required** (spec §5 says `auth` is encrypted). Use a
  key from env (e.g. `ENCRYPTION_KEY`, 32-byte, AES-256-GCM via `node:crypto`).
  Never log decrypted tokens. Add it to `.env.example`.
- `task_estimates`: add `source` (`'manual' | 'jira'`) and `synced_at`.
- Additive migration only. Don't reshape existing tables.

## 6. Scope

**A. Connect Jira (Settings)**
- "Connect Jira" → OAuth redirect → callback stores encrypted tokens + cloudId +
  the user's Jira `accountId`. Show connected site + account, and a
  **Disconnect** button that deletes the tokens.
- Refresh the access token transparently when expired; if refresh fails, mark
  the connection broken and surface "reconnect" in the UI rather than failing
  silently.
- CSRF-protect the callback with the OAuth `state` param.

**B. Estimates from Jira**
- On Task detail (and a small batch job), fetch the issue and upsert
  `task_estimates` with `source: 'jira'`.
- A Jira estimate should win over a stale manual one, but **never silently wipe
  a manual estimate when Jira has none** — leave the manual value and label it.
- **Known gap to handle gracefully:** many teams estimate in **story points**, a
  per-instance custom field, not hours. If `originalEstimate` is empty, show
  "no estimate in Jira" rather than 0 — and do not compute a compression ratio
  from a zero estimate (today's Task detail would show a nonsense `0.01×`).

**C. Nightly draft rollup**
- Group each user's sessions by `issue_key` + local date → one `worklog_drafts`
  row with summed `reported_seconds`, `session_ids`, and a generated description.
- **Idempotent**: re-running must update the existing draft, not duplicate it.
  Never touch drafts already `approved` / `synced` / `dismissed`.
- Skip sessions with no issue key (they can't be logged anywhere).
- Runs from the existing cron route pattern (`/api/cron/...`, `CRON_SECRET`);
  remember Vercel Hobby allows **one cron per day**.

**D. Drafts screen**
- List drafts (default: this week, status `draft`), grouped by date.
- Per row: editable seconds + description, **Approve**, **Dismiss**.
- **Approve all** for a day.
- Own-data only, enforced in the query — a user must never load or mutate
  someone else's draft (verify by id + user_id on every mutation).
- Show sync state and the error message when a push failed.

**E. Sync worker**
- Adapter interface per spec §4.6: `resolveIssue(key)`, `createIssue(draft)`,
  `pushWorklog(draft)`. One implementation now; client adapters stay out of
  scope but must slot in later.
- Flow: resolve key → numeric issueId → POST Tempo worklog → store
  `tempo_worklog_id`, set `synced_at`, status `synced`.
- **Idempotency is the hard part.** Tag every worklog description with
  `[mnl-dev-telemetry:<draft_id>]`. Before creating, search Tempo for an
  existing worklog carrying that tag and skip if found. A retry after a timeout
  must never double-log.
- Mirror tickets: if the issue key isn't resolvable in the connected Jira,
  find-or-create a mirror in our Jira (label `mnl-dev-telemetry-mirror`,
  external key recorded via `mirror_links`) and log against the mirror.
- `audit_log` rows on approve and on push.

## 7. Out of scope

Client Jira adapters (Phase 7) · editing Jira issues beyond worklogs · pulling
story-point custom fields · bulk backfill of historical worklogs · auto-approval.

## 8. Acceptance checks

- Dev links their own Jira from Settings; tokens in the DB are **encrypted**
  (verify by eyeballing the row — no readable token).
- Task detail shows an estimate pulled from Jira; a ticket with no estimate
  shows "no estimate" and **no** compression ratio.
- Nightly rollup produces one draft per ticket per day; re-running changes
  nothing (idempotent); approved/synced drafts are untouched.
- Approving a draft creates **exactly one** Tempo worklog on the right issue,
  authored as that dev. Running sync twice creates no duplicate.
- A dismissed draft never syncs.
- User A cannot read or approve user B's draft (test the query, not the UI).
- Token refresh works; a revoked connection surfaces "reconnect", doesn't crash.
- Unit tests for pure logic: rollup grouping, description/tag generation,
  idempotency-tag parsing, estimate precedence. Mock HTTP for adapter tests —
  no live Jira calls in the test suite.

## 9. Kickoff prompt for the new session

```
Read CLAUDE.md, docs/devpulse-mvp-brief.md, docs/phase-4-notes.md, and
docs/phase-5-jira-brief.md, then implement Phase 5. Do not start other phases.

Note §2 of the Phase 5 brief: we are using per-user Jira OAuth, which
supersedes the shared service account in the original §4.6. Verify the current
Jira Cloud OAuth and Tempo v4 docs before writing the adapter rather than
relying on memory.

Build in this order so each step is verifiable on its own:
  1. Encrypted credential storage + schema migration
  2. Jira OAuth connect/disconnect in Settings
  3. Estimate pull-down into task_estimates
  4. Nightly draft rollup (idempotent) + tests
  5. Drafts screen (edit / approve / dismiss)
  6. Tempo push with [mnl-dev-telemetry:<draft_id>] idempotency + mirror tickets

Do not let a Jira/Tempo outage break the dashboard — sync failures must surface
as a status on the draft, never a 500 on a page.

When done, write docs/phase-5-notes.md including how to set up the Atlassian
OAuth app (redirect URI, scopes) and how Tempo auth was resolved.
```

## 10. Setup you'll need (human, before or during the session)

- **Atlassian OAuth app** — developer.atlassian.com → Console → *Create* → OAuth
  2.0 integration. Add the Jira API, set scopes (§4), and set the callback URL to
  both `http://localhost:3000/api/jira/callback` and your Vercel URL. Copy the
  client id/secret into env (`JIRA_OAUTH_CLIENT_ID` / `_SECRET`).
- **Tempo credential** — per the decision in §4: either generate a personal API
  token (Tempo → Settings → API integration) or register a Tempo OAuth app.
- **`ENCRYPTION_KEY`** — `openssl rand -base64 32`.
- A Jira project with a ticket that has a real **original estimate in hours** to
  test against (story points won't exercise the path).
