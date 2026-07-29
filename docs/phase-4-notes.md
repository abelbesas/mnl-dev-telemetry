# Phase 4 — Stitching + read-only dashboard notes

Scope delivered: the session-stitching job (spec §4.2) with full vitest
coverage, and the read-only dashboard (spec §4.5) — Auth.js SSO + a dev-login
fallback, My timeline, Task detail (estimate vs actual), Team aggregates
(leads only), Settings (agent tokens + working hours), and the SSO-gated
`/activate` device-approval page. Plus a dev-only demo seed. All Phase-4
acceptance checks pass; **Phase 3 (MCP) and Phase 5 (drafts/sync) were not
started** — this phase was deliberately built before Phase 3 to get a demoable
dashboard sooner (see "Demo-first ordering" below).

## Layout (new/changed)

```
apps/dashboard/
  drizzle/0002_flawless_harrier.sql          # + task_estimates, users.tz/workday_*, task_sessions.reported_seconds
  src/
    auth.ts                                  # NextAuth v5: Google SSO + dev-login, jwt/session callbacks
    types/next-auth.d.ts                     # session.user.id / role augmentation
    app/
      globals.css                            # hand-rolled minimal design system
      layout.tsx                             # imports globals
      login/page.tsx                         # Google + dev-login forms
      (app)/                                 # authed route group (shell + guard)
        layout.tsx  page.tsx(→/timeline)
        timeline/page.tsx                    # My timeline
        tasks/[issueKey]/page.tsx            # Task detail (estimate vs actual)
        team/page.tsx                        # Team aggregates (requireLead)
        settings/page.tsx                    # tokens + working hours
        activate/page.tsx                    # SSO-gated device approve
      api/auth/[...nextauth]/route.ts        # Auth.js handlers
      api/auth/device/approve/route.ts       # now SSO-gated (was Phase-2 stand-in)
      api/cron/stitch/route.ts               # scheduled stitch trigger
    components/                              # Nav, charts (SVG), GenerateTokenForm, ActivateForm
    lib/
      stitch.ts                              # PURE stitch core + working-hours clamp
      tz.ts                                  # PURE Intl-based tz helpers
      stitch-run.ts                          # DB runner (delete+rebuild, stitch_version)
      aggregate.ts                           # PURE team math
      queries.ts                             # data access, own-data enforced
      session.ts range.ts format.ts device-approve.ts
    db/
      schema.ts                              # + task_estimates, new columns
      seed-demo.ts                           # dev-only mixed dataset
  test/{stitch,aggregate}.test.ts            # 27 new tests
```

## Key decisions

- **Stitching is pure + DB-free at its core** (`lib/stitch.ts`). `stitchUserEvents`
  groups by `issue_key` (fallback repo+branch), opens a session at the first
  event, and closes it on a >45-min gap **or** an explicit `session_end` /
  `task_stop` (the boundary event is included in the closing session). Output is
  sorted deterministically (group key, then start time), so the same events
  always yield byte-identical sessions regardless of input order — the property
  that makes "re-run from scratch" safe. `stitch-run.ts` is the only impure part:
  it loads events + per-user settings, calls the pure core, and replaces that
  user's `task_sessions` in one transaction with a fresh monotonic
  `stitch_version`.

- **Working-hours clamp without a date library** (`lib/tz.ts`). The clamp
  (`clampedSecondsForSpan`) sums the overlap of a session with each local
  working-hours window (09:00–18:00, Mon–Fri, per-user TZ) across every calendar
  day it touches. Timezone math uses the built-in `Intl` database (DST-correct)
  behind pure functions — `wallTimeToUtc` does a two-pass offset resolution so it
  is correct across DST jumps, even though Manila itself has none. Raw span
  (`ended - started`) is kept alongside the clamped **reported** seconds.

- **New `task_sessions.reported_seconds` column.** Spec §4.2.3 keeps the raw span
  (via `started_at`/`ended_at`) but the *reported* (clamped) seconds is the
  number the timeline/task views and Phase-5 drafts actually use, so it is
  persisted rather than recomputed on every read. Additive migration.

- **AI attribution honours commit co-author trailers** (the demo-first
  adjustment). `ai_assisted` is true if a session contains any `mcp`/`cc_hook`
  event **or** any commit whose metadata carries an `ai_co_author` trailer — the
  latter is what actually exists pre-Phase-3. `ai_tool` is normalised to a
  friendly label ("Claude Code", "GitHub Copilot", …). For `mcp`/`cc_hook`, the
  agent is Claude Code in the MVP; `metadata.tool` there is the *invoked MCP tool*
  (e.g. `log_context`), so it is only trusted as the agent name when it clearly
  names a known agent (as session-event metadata can) — a subtlety caught by a
  test.

- **Auth.js v5 (`next-auth@5.0.0-beta.32`) with the JWT strategy, no adapter.**
  The existing `users` table stays the single source of identity: on sign-in we
  upsert by email and stamp the DB `id` + `role` onto the token
  (`session.user.id`/`role`). Google Workspace SSO is the production path;
  `Credentials` "dev login" is registered **only** when `DEV_LOGIN_ENABLED=true`
  and can only assume an *existing* user (no password, no new accounts, no role
  escalation). Google is registered only when `AUTH_GOOGLE_ID` is set, so the
  demo runs on dev login alone.

- **Own-data enforced in queries, not just UI** (spec §2.6). Every individual
  read in `lib/queries.ts` filters by `userId`; `getTaskDetail` returns null for
  a ticket the caller has no sessions on (verified live: a lead still can't open
  another dev's task detail). Team reads deliberately span all users and are only
  reachable through `requireLead()`, which redirects non-leads to `/timeline`.

- **Estimates are a manual, ticket-level field** (`task_estimates`, unique on
  `issue_key`). Task detail shows estimate vs actual + a compression ratio; the
  estimate is editable inline. Jira population is Phase 5 (noted in the UI).

- **Device approval is now SSO-gated** (Phase-2's `approve` route was an
  unauthenticated stand-in). The approve logic moved to `lib/device-approve.ts`
  and takes identity from the dashboard session — never the request body. The
  `/activate` page is the human path; the `/api/auth/device/approve` route still
  exists but now requires a session and derives the user from it.

- **Charts are hand-rolled SVG** (`components/charts.tsx`), no chart lib — keeping
  the UI minimal per spec while still delivering "the charts that matter":
  compression-ratio trend (line, 1.0 reference) and AI-vs-non-AI cohort bars.

## Demo-first ordering (adjustments vs the spec's phase order)

- **Phase 3 (MCP) skipped for now.** The stitcher's `ai_assisted` would normally
  key off `mcp`/`cc_hook` events; since those don't exist yet, it also honours
  commit **AI co-author trailers**, and the demo seed produces a realistic mixed
  stream (git-hook commits/pushes + synthesised `mcp`/`cc_hook`/co-author signals)
  so the AI story is visible today. When Phase 3 lands, real MCP/CC events flow
  through the identical code path — no stitcher change needed.
- **Drafts / Tempo sync (spec §4.2 step 5, §4.5 Drafts, §4.6) intentionally NOT
  built** — that is Phase 5. `worklog_drafts` already exists (Phase 1); the
  stitcher stops at `task_sessions`.
- **Estimates manual** for now (Jira fetch is Phase 5).
- **Dev-login fallback** added so the demo never blocks on Google SSO approval.

## Demo seed (`pnpm db:seed:demo`)

Dev-only (refuses `NODE_ENV=production` without `DEMO_SEED_FORCE=1`). Deterministic
(seeded PRNG → same dataset every run). Creates **3 devs + 1 lead**, ~2.5 working
weeks of events across several tickets/repos, with AI usage biased per dev (Alice
heavy, Carol light). It inserts the raw events, then runs the **real**
`stitchUserEvents` to build sessions. Only the per-ticket **estimates** are
synthesised — derived from each ticket's stitched actual so AI tickets land
~0.55–0.75× and non-AI ~0.9–1.15× estimate, making the compression and cohort
charts legible. Re-running is idempotent (clears prior demo data first).

## Gotchas

- **The team view counts *all* users**, including any left over from earlier
  phases (e.g. `dev@mnl-dev-telemetry.local` from the Phase-1 seed, device-auth test
  users). For a pristine team demo, reset the DB first (see demo script step 0).
- **`declaration: false` in `apps/dashboard/tsconfig.json`.** next-auth v5's
  inferred `auth` type otherwise triggers TS2742 ("cannot be named…") under the
  repo's inherited `declaration: true`. The dashboard is a `noEmit` Next app, so
  emitting declarations was never wanted.
- **Seed uses relative imports + the pure stitcher** (not `stitch-run.ts`), so it
  runs under `tsx` without `@/*` path-alias resolution — mirroring the existing
  `seed.ts`/`migrate.ts` convention.
- **Timeline "today"/"this week" use the real clock**; the seed anchors data to
  the actual current date at seed time, so the two always line up whenever you run
  the demo.

## Run it

```bash
pnpm install
pnpm db:up
pnpm db:migrate          # applies 0002 (task_estimates, new columns)
pnpm test                # 82 tests (21 shared, 37 dashboard, 24 setup-cli)

# Dashboard needs AUTH_SECRET + a login method in apps/dashboard/.env:
#   AUTH_SECRET=$(openssl rand -base64 32)
#   DEV_LOGIN_ENABLED=true            # demo login (no Google needed)
pnpm --filter @mnl-dev-telemetry/dashboard dev
```

## Acceptance — verified

Spec §4 acceptance:
- **Seeded raw events produce the expected sessions in tests** — 20 stitch tests
  cover gap handling, explicit `session_end`/`task_stop` boundaries,
  issue-key/repo grouping, the AI flag (mcp, cc_hook, co-author trailer), and the
  working-hours clamp (inside/pre-09:00/post-18:00/weekend/multi-day, Manila +
  a DST zone).
- **A dev sees only their own sessions** — enforced in `queries.ts`; verified
  live that even a lead gets "no sessions" on another dev's task detail.
- **Re-running stitching from scratch is deterministic** — pure-function test
  (shuffled input → identical output) **and** verified at the DB level: two
  back-to-back `POST /api/cron/stitch` runs produced an identical session
  signature.

Also verified live (dev-login as the seeded lead/dev):
- Login → My timeline (day groups, AI badge, reported vs raw), Task detail
  (estimate vs actual, compression 0.73× "27% under"), Team (compression trend
  0.59×→0.69×; AI cohort **0.66×** vs non-AI **1.13×**; weekly throughput;
  lead-only), Settings (working hours; token issue shows one-time plaintext;
  revoke), `/activate`.
- `next build` succeeds (14 routes); `pnpm typecheck` clean.

## Demo script

Walks the story: *dev commits code → sessions appear on a timeline → estimate vs
actual, with an AI badge → leads see the AI-vs-not payoff.*

```bash
# 0. (optional) pristine DB so the team view shows only demo users
pnpm db:down && pnpm db:up && sleep 3 && pnpm db:migrate

# 1. seed the mixed dataset (3 devs + 1 lead, ~2.5 weeks, some AI-assisted)
pnpm db:seed:demo
#    → prints the dev-login emails to use

# 2. ensure apps/dashboard/.env has:
#      AUTH_SECRET=<openssl rand -base64 32>
#      DEV_LOGIN_ENABLED=true
pnpm --filter @mnl-dev-telemetry/dashboard dev     # http://localhost:3000
```

Then, in the browser:

1. **Sign in as a dev** — `alice@mnl-dev-telemetry.local` (heavy AI user). Land on
   **My timeline**: sessions grouped by day, each with clock range, a purple
   **✦ Claude Code** badge where AI was involved, a reported-time bar, and
   "…raw" where the working-hours clamp trimmed the span. Note the top tiles:
   reported hours this week, **AI-assisted share**, tasks touched.
2. **Click a ticket** (e.g. `WEB-101`) → **Task detail**: Estimate vs
   Actual (reported) vs Raw span, and a **compression ratio** (green when under
   estimate). Edit the estimate inline and Save to show it recompute.
3. **Sign out, sign in as the lead** — `dana@mnl-dev-telemetry.local`. The **Team** link
   now appears. Open it:
   - **Estimate-compression ratio over time** — trend line with a 1.0 reference.
   - **AI-assisted vs not** — the headline: AI tickets came in well under
     estimate (~0.66×) vs non-AI (~1.13×).
   - **Throughput per week** — tickets touched + hours.
4. **Settings** → issue an agent token (shown once) and revoke one; adjust
   working hours (drives the stitcher's clamp on the next run).
5. **Activate device** → the SSO-gated screen a dev uses to authorize
   `npx @mnl-dev-telemetry/setup` (replaces the Phase-2 curl).

To show the stitcher re-running deterministically:
`curl -X POST localhost:3000/api/cron/stitch` (safe to run repeatedly).

## For Phase 5 / Phase 3

- **Phase 5 (drafts + Tempo):** `worklog_drafts` exists; add the nightly rollup
  (spec §4.2 step 5) grouping `task_sessions` by `issue_key` + date, the Drafts
  screen (edit/approve), and the sync worker (`resolveIssue`/`createIssue`/
  `pushWorklog`, mirror tickets, `[mnl-dev-telemetry]` idempotency). `reported_seconds` is
  the field to roll up. Replace the manual estimate with a Jira fetch.
- **Phase 3 (MCP):** real `mcp`/`cc_hook` events already flow through the same
  ingestion + stitching path; the AI flag will pick them up with no stitcher
  change. `session_start`/`session_end` already close/segment sessions correctly.
- **Auth hardening:** wire `AUTH_GOOGLE_ID/SECRET` and turn `DEV_LOGIN_ENABLED`
  off in any shared/staging env. Consider an `audit_log` row on working-hours
  changes.
- **Scale note:** the stitch runner deletes+rebuilds per user in a transaction —
  fine for the MVP; batch or incrementalise if the event volume grows.
```
