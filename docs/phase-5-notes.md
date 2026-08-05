# Phase 5 — Jira connection, drafts, one-click Tempo sync

Scope delivered: per-user Jira OAuth 2.0 (3LO) with encrypted server-side token
storage, Jira estimate pull-down, the idempotent nightly draft rollup, the
Drafts screen (edit / approve / dismiss / approve-all), and the Tempo v4 sync
worker with `[mnl-dev-telemetry:<draft_id>]` idempotency and mirror tickets.
Built in the six steps named in the kickoff prompt, each verifiable on its own.

**Not started:** Phase 3 (MCP server) and Phase 7 (client Jira adapters) — the
adapter interface ships so the latter slots in.

**One thing needs you before a live push works:** an Atlassian OAuth app and a
Tempo API token (see "Setting up the Atlassian OAuth app" and "How Tempo auth
was resolved"). Everything up to the network boundary is verified; the live
round-trip to Atlassian/Tempo is the part I could not exercise without your
credentials.

## Layout (new/changed)

```
packages/shared/src/
  jira.ts                                  # NEW zod schemas for every Jira/Tempo payload
apps/dashboard/
  drizzle/0003_medical_ultimo.sql          # + per-user connection cols, estimate source, draft sync state
  drizzle/0004_peaceful_baron_strucker.sql # + worklog_drafts.edited
  vercel.json                              # cron → /api/cron/nightly, 14:00 UTC (22:00 Manila)
  src/
    lib/
      crypto.ts                            # PURE AES-256-GCM envelope (ENCRYPTION_KEY)
      sync-tag.ts                          # PURE build/parse/strip the idempotency tag
      rollup.ts                            # PURE sessions → draft candidates
      rollup-run.ts                        # DB runner, idempotent reconcile
      drafts.ts                            # draft queries — own-data enforced
      estimates.ts                         # PURE precedence + Jira pull-down
      sync-run.ts                          # sync worker; never throws outward
      jira/
        oauth.ts                           # 3LO: authorize / exchange / refresh / resources
        connection.ts                      # encrypted persistence + transparent refresh
        client.ts                          # Jira REST v3 (2 transports: OAuth, Basic)
        tempo.ts                           # Tempo REST v4
        adapter.ts                         # spec §4.6 adapter + mirror logic
    app/
      (app)/drafts/page.tsx                # NEW the core screen
      (app)/settings/page.tsx              # + Jira connection + Tempo token cards
      (app)/tasks/[issueKey]/page.tsx      # Jira estimate, no-estimate handling
      api/jira/connect/route.ts            # NEW OAuth start (state cookie)
      api/jira/callback/route.ts           # NEW OAuth callback (CSRF-checked)
      api/cron/nightly/route.ts            # NEW stitch → rollup → sync-retry
    components/
      JiraConnectionCard.tsx TempoTokenForm.tsx DraftRow.tsx ApproveDayButton.tsx
  test/
    crypto.test.ts connection-db.test.ts   # credential-at-rest
    rollup.test.ts drafts-db.test.ts       # rollup + own-data + sync guards
    estimates.test.ts jira-client.test.ts adapter.test.ts
```

## Setting up the Atlassian OAuth app

Do this once per environment (local + each deployed URL).

1. **developer.atlassian.com** → *Console* → **Create** → *OAuth 2.0 integration*.
   Name it (e.g. "MnlDevTelemetry") and accept the terms.
2. **Permissions** → add **Jira API** → *Configure* → **Add** these scopes:

   | Scope | Why it's needed |
   |---|---|
   | `read:jira-work` | `GET /issue/{key}` — estimates + the key→numeric-id resolution Tempo requires; `POST /search/jql` for mirror lookup |
   | `write:jira-work` | `POST /issue` — **mirror tickets only** |
   | `read:jira-user` | `GET /myself` → `accountId`, which becomes Tempo's `authorAccountId` |
   | `offline_access` | refresh tokens — **without it the link dies after one hour** |

   These are the *classic* scopes. The granular equivalents
   (`read:issue:jira`, …) are still marked Beta in Atlassian's spec, so classic
   is the right choice today.
3. **Authorization** → *OAuth 2.0 (3LO)* → **Configure** → set the **Callback URL**.
   It must match `<APP_URL>/api/jira/callback` **exactly**, including scheme and
   port. Add one app per environment, or add both URLs if your app allows it:
   - `http://localhost:3000/api/jira/callback`
   - `https://<your-vercel-app>.vercel.app/api/jira/callback`
4. **Settings** → copy the **Client ID** and **Secret** into the server env:

   ```
   JIRA_OAUTH_CLIENT_ID=...
   JIRA_OAUTH_CLIENT_SECRET=...
   APP_URL=http://localhost:3000        # drives the redirect_uri we send
   ENCRYPTION_KEY=$(openssl rand -base64 32)
   ```

   `ENCRYPTION_KEY` is **required** — Settings refuses to offer the Jira link
   without it rather than storing a token in the clear.

The authorize URL we build carries `audience=api.atlassian.com`,
`response_type=code`, `prompt=consent`, the scopes above, the redirect URI, and
a random `state`. `prompt=consent` is deliberate: it guarantees a fresh refresh
token on every re-link instead of silently returning an access token only.

**Common setup failures**

- *"redirect_uri is not registered"* — the callback URL must match to the
  character. A trailing slash or `127.0.0.1` vs `localhost` will fail.
- *Link works, then breaks in an hour* — `offline_access` wasn't granted;
  re-run the link after adding the scope.
- *Rotating `ENCRYPTION_KEY`* invalidates every stored connection. The UI
  reports "reconnect" rather than half-working; devs just re-link.

## How Tempo auth was resolved

**Decision: each dev pastes their own Tempo API token in Settings; the server
stores it encrypted.** Jira OAuth is *not* reused, because it cannot be.

The brief flagged this as the trap, and the current docs confirm it: **Tempo is
a separate vendor from Atlassian.** Linking Jira grants no Tempo access at all —
they are different authorization servers issuing different bearer tokens.
Tempo's own API docs describe exactly two options:

1. **Per-user API token** — *Tempo → Settings → Data Access → API integration*.
   Any dev can generate one for themselves, scoped to their own permissions.
2. **Tempo OAuth 2.0 app** — *Tempo → Settings → Data Access → OAuth 2.0
   authentication*, then an `authorization_code` flow via
   `https://api.tempo.io/oauth/authorize/redirect?client_id=…&redirect_uri=…&jira_url=…`.

**We took option 1**, because option 2 requires a **Tempo administrator** to
register an app before *anyone* can try the feature — the same "needs an admin
to provision it first" objection that made us drop the shared Jira service
account in §2 of the brief. Option 1 needs no admin, is per-user (so worklogs
are still authored as the individual), and satisfies constraint 3 unchanged:
the token is entered in the browser, encrypted with AES-256-GCM, stored only
server-side, and never sent to a dev machine or into an agent token's scope.

Option 2 remains open. `TempoClient` takes a bearer token and nothing else, and
`getCredentials()` is the single place a token is resolved — an OAuth link flow
would add a second way to populate `jira_connections.tempo_auth` and change
nothing else.

There's also an **upgrade notice** in Tempo's docs worth knowing about: as Tempo
migrates from Atlassian Connect to Forge, the legacy authorize URL
(`{site}.atlassian.net/plugins/servlet/ac/io.tempo.jira/oauth-authorize/`) is
being deprecated in favour of the `api.tempo.io/oauth/authorize/redirect` form
above. Only relevant if we later take option 2.

## API facts re-verified (not taken from memory)

Per CLAUDE.md. The brief's §4 was mostly right; three things needed correcting
or pinning down:

- **`/rest/api/3/search` is gone.** It was deprecated in 2025 and now returns
  **410 Gone**. The replacement is **`POST /rest/api/3/search/jql`**, with
  `nextPageToken` pagination instead of `startAt`. Mirror lookup uses the new
  endpoint. (Verified against Atlassian's `swagger-v3.v3.json`.)
- **Tempo v4 base + shape** confirmed from `apidocs.tempo.io/tempo-openapi.yaml`:
  `POST /4/worklogs` with **required** `issueId` (integer), `authorAccountId`,
  `startDate`, `timeSpentSeconds` (min 1); `description` optional.
  `POST /4/worklogs/search` takes `{issueIds, from, to, authorIds}` — that is
  the idempotency probe. Response carries `tempoWorklogId` (integer).
- **Tempo has regional clusters** — `https://api.eu.tempo.io`,
  `https://api.us.tempo.io`, `https://api.tempo.io`. Calling the wrong one
  returns an authorization error, so it's configurable via
  `TEMPO_API_BASE_URL`.
- Jira estimate lives at `fields.timetracking.originalEstimateSeconds`, with
  `fields.timeoriginalestimate` as the flat fallback. Both in seconds.

## Key decisions

- **Credentials are one opaque envelope, not per-field columns**
  (`lib/crypto.ts`). `auth` / `tempo_auth` hold `{ enc: "v1.<iv>.<tag>.<ct>" }`
  — a single AES-256-GCM ciphertext over the whole bundle, so the row leaks
  neither the token values *nor the field names*, i.e. nothing about which
  credentials a user has. The envelope is versioned so the format can rotate
  without a data migration. `getEncryptionKey()` throws rather than falling back
  to a weak key: a silent downgrade here is worse than an outage. The
  acceptance check ("eyeball the row — no readable token") is asserted, not
  eyeballed, in `test/connection-db.test.ts` using plaintext canaries.

- **Sync failures are draft state, never a page error.** This is the kickoff
  prompt's hard requirement, and it's enforced structurally: `syncDraft()` and
  `runSync()` **never throw** for an outbound failure — they write
  `worklog_drafts.sync_error` + `sync_attempted_at` and return an outcome. Every
  page that touches Jira (`/tasks/[key]`, `/settings`, `/drafts`) wraps its
  read in a catch. `syncEstimateFromJira()` likewise returns an
  `EstimateSyncResult` rather than throwing. Both API clients carry a 10s
  timeout so a hung Atlassian can't hang a render. **Verified live:** approving
  a draft with no Jira linked leaves the page fully rendered, the row badged
  "sync failed" with the reason inline and a Retry action, and the "needs
  attention" tile at 1.

- **Idempotency is a search-before-create, not a hope.** Tempo has no
  idempotency key, so `pushWorklog` tags every description
  `[mnl-dev-telemetry:<draft_id>]` and, before creating, searches
  `POST /4/worklogs/search` scoped to that issue + day + author for a worklog
  already carrying the tag. If the probe *fails*, we **refuse to create** —
  being unable to prove absence is exactly the double-log risk the probe
  exists to prevent. Tested against a fake Tempo that really stores what you
  post, including the nasty case (a push that timed out after Tempo committed).

- **The rollup skips writes on material equality, ignoring session-id churn.**
  Found while verifying: the stitcher deletes and re-inserts `task_sessions`
  with fresh UUIDs on every run (by design — they're derived and rebuildable),
  so comparing `session_ids` made *every* nightly run rewrite *every* draft and
  pinned `unchanged` at zero. `draftMatches()` now compares seconds +
  description. Repeated `/api/cron/nightly` runs are now genuinely
  write-free: `created 0, updated 0, unchanged 77, preserved 1`.
  **Accepted consequence:** `session_ids` on an untouched draft keeps the ids
  from the run that last wrote it, and those ids don't resolve after a
  re-stitch. They're provenance, not a foreign key, and nothing reads them back.

- **A dev's edit wins over the rollup** (`worklog_drafts.edited`, migration
  0004). Also found while verifying: editing a draft's hours appeared to
  "not save", because the Drafts page re-runs the rollup on load and re-derived
  the row straight back to the session-computed number. An explicit `edited`
  flag now pins the row — `canRollupOverwrite(status, edited)` excludes it, and
  the flag is re-asserted in the UPDATE's WHERE so a concurrent edit can't be
  clobbered. This replaced an earlier regex heuristic that guessed whether a
  description was still machine-generated; an explicit flag is honest and
  covers the seconds too.

- **Own-data is enforced in the queries** (spec §2.6). Every mutation in
  `lib/drafts.ts` matches `id AND user_id` (plus a status guard), so a user who
  guesses another's draft id updates **zero rows** rather than someone else's
  timesheet. `test/drafts-db.test.ts` proves read/approve/edit/dismiss and
  approve-all all refuse across users — at the query level, as the brief asks.

- **Estimates: Jira wins, but never silently wipes.** `resolveEstimate()` is
  pure and encodes exactly two rules — a real Jira estimate replaces a stale
  manual one; Jira having *none* leaves the manual value alone and labels it.
  A zero/absent estimate returns `null`, never `0`, so `compressionRatio()`
  returns no ratio at all rather than the nonsense `0.01×` the brief flagged.
  Story-point tickets say "no estimate in Jira" and explain why.

- **Mirror tickets are found three ways before being created**: the
  `mirror_links` row, then a JQL search on label + summary (so a lost DB row
  doesn't create a *second* mirror after a DB reset), then create. The external
  key is written into the mirror's description as well as `mirror_links`, which
  is what makes the JQL recovery possible. Unique index on
  `external_issue_key` makes find-or-create idempotent.

- **The org service account survives only for mirroring.** Per brief §2 it is
  no longer the primary auth path; `getServiceAccount()` is read *only* when a
  mirror ticket must be created in our own Jira. Absent config disables
  mirroring with a clear, non-retryable message rather than failing obscurely.

- **One cron route, three stages** (`/api/cron/nightly`: stitch → rollup →
  sync-retry). Vercel Hobby allows one cron per day, and the stages are ordered
  anyway. Each is independently idempotent. Schedule moved to `0 14 * * *` —
  14:00 UTC is **22:00 Asia/Manila**, i.e. actually nightly; the inherited
  `0 3 * * *` was 11:00 Manila, mid-workday, which would roll up partial days.
  `/api/cron/stitch` is kept for compatibility.

- **Error classification drives retry.** `SyncError` carries `retryable` and
  `needsReconnect`. 4xx (except 429) is permanent — retrying burns quota;
  5xx/timeouts retry on the next nightly run. `401` means reconnect; **`403`
  deliberately does not**, since re-authorizing cannot fix a permissions gap.

## Gotchas

- **Route modules may only export route handlers.** `export const
  OAUTH_STATE_COOKIE` in `api/jira/connect/route.ts` failed `next build` with
  *"not a valid Route export field"* (it typechecks fine — only the build
  catches it). The constant lives in `lib/jira/oauth.ts` now.
- **Atlassian rotates refresh tokens.** The refresh response's new
  `refresh_token` **must** be persisted or the *next* refresh fails.
  `getCredentials()` writes it back, falling back to the old one when absent.
- **Only a definitive rejection burns a connection.** A 400/403 from the token
  endpoint marks it `broken`; a network blip does not, or one Atlassian hiccup
  would force every dev to re-link.
- **`DEFAULT` order matters for the unique index on `jira_connections.user_id`.**
  Postgres allows repeated NULLs in a unique index, so org-level rows
  (`user_id NULL`) stay unconstrained while per-user rows are one-per-user —
  no partial index needed.
- **The demo seed currently fails on this DB.** Left-over users from before the
  DevPulse→MnlDevTelemetry rename (`*@devpulse.local`) hold events whose
  deterministic UUIDs collide with the re-seeded ones. Not a Phase-5 change;
  reset the DB (`pnpm db:down && pnpm db:up && pnpm db:migrate`) before
  re-seeding, or verify against the existing `*@devpulse.local` users as I did.
- **Tempo `timeSpentSeconds` must be ≥ 1.** The rollup drops zero-second
  sessions rather than creating a draft that could never sync, and
  `updateDraft` rejects a zero edit with a real message.

## Run it

```bash
pnpm install
pnpm db:up
pnpm db:migrate          # applies 0003 + 0004
pnpm test                # 305 tests (31 shared, 162 dashboard, 28 setup-cli, 84 vscode)

# apps/dashboard/.env needs, on top of Phase 4's AUTH_SECRET + DEV_LOGIN_ENABLED:
#   ENCRYPTION_KEY=$(openssl rand -base64 32)     # required for any Jira link
#   JIRA_OAUTH_CLIENT_ID=... JIRA_OAUTH_CLIENT_SECRET=...
pnpm --filter @mnl-dev-telemetry/dashboard dev
```

The DB-backed tests (`drafts-db`, `connection-db`) **skip themselves** when
Postgres isn't reachable, so `pnpm test` stays green in CI without docker.

## Acceptance — status

Verified:

- **Tokens in the DB are encrypted** — asserted with plaintext canaries against
  the real stored row; neither token values nor bundle field names appear.
  Round-trips correctly server-side. (`connection-db.test.ts`)
- **A ticket with no estimate shows "no estimate" and no compression ratio** —
  verified live on `WEB-101`: Estimate "—" / "no estimate in Jira",
  Compression "—" / "needs an estimate". Setting 14h by hand then shows
  `0.78× · 22% under`.
- **Nightly rollup produces one draft per ticket per day; re-running changes
  nothing; approved/synced/dismissed are untouched** — verified live over three
  consecutive `/api/cron/nightly` runs (`created 0, updated 0, unchanged 77,
  preserved 1`) and in `drafts-db.test.ts`.
- **Approving creates exactly one Tempo worklog; running sync twice creates no
  duplicate** — `adapter.test.ts` against a fake Tempo that stores what it
  receives: two pushes → one worklog, second returns `deduped`. Also covers a
  worklog left behind by a timed-out push, and refusing to create when the
  probe itself fails.
- **A dismissed draft never syncs** — refused even when `syncDraft` is called
  directly with an adapter that throws if reached. (`drafts-db.test.ts`)
- **User A cannot read or approve user B's draft** — tested at the query level
  for read, approve, edit, dismiss and approve-all. (`drafts-db.test.ts`)
- **A revoked connection surfaces "reconnect" and doesn't crash** — `broken`
  status and an unreadable bundle both raise a typed, reconnect-flagged error;
  Settings renders the reconnect prompt. (`connection-db.test.ts`)
- **Sync failure never 500s a page** — verified live (see above).
- **CSRF on the callback** — verified live: a forged `state` yields "Jira
  authorization could not be verified" and the code is never exchanged. The
  state cookie is httpOnly (confirmed from the page's JS context), and
  `/api/jira/connect` requires a session.
- **Unit tests for pure logic; HTTP mocked, no live Jira in the suite** — 26
  rollup/tag, 9 estimate, 20 client/OAuth, 16 adapter, 13 crypto.
- `pnpm typecheck` clean; `next build` succeeds (19 routes).

**Not verified — needs your credentials:**

- **A live end-to-end push to real Jira + Tempo.** Everything up to the socket
  is exercised (the adapter tests drive the real client code through real
  `Request`/`Response` objects), but I have no Atlassian OAuth app or Tempo
  token, so no request has actually reached Atlassian or Tempo. The
  first live run is the thing to try after the setup above — in particular
  confirm your Tempo **regional cluster** (`TEMPO_API_BASE_URL`) and that the
  test ticket has a real **original estimate in hours**, since story points
  won't exercise the estimate path.
- **Token refresh against Atlassian.** The refresh logic, expiry skew, and
  rotation-persistence are unit-tested, but the hour-long expiry has not been
  waited out against a live grant.

## For Phase 3 / Phase 7

- **Phase 3 (MCP):** unchanged by this phase. Real `mcp`/`cc_hook` events flow
  through the same ingestion → stitch → rollup path; drafts will simply start
  showing `AI-assisted (Claude Code)` from real agent events rather than only
  from commit co-author trailers.
- **Phase 7 (client Jira adapters):** implement `SyncAdapter`
  (`resolveIssue` / `createIssue` / `pushWorklog`) in `lib/jira/adapter.ts` and
  pick it in `buildAdapter()` based on the draft's project. The sync worker,
  the tag idempotency, and the Drafts UI need no changes.
- **Worth doing soon:** a `sync_attempts` counter so a permanently-failing draft
  stops being retried nightly forever, and surfacing `audit_log` (rows are
  written on `jira.connect`, `jira.disconnect`, `tempo.token.*`,
  `draft.approve`, `draft.dismiss`, `draft.sync`) somewhere in the UI.
- **Scale note:** `runSync` groups by user so one adapter and one token refresh
  serve all of that user's drafts, and one broken connection can't stall
  everyone else's. It processes at most 100 drafts per run.
