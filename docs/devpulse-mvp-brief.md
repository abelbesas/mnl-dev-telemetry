# DevPulse — MVP Build Brief

A client-agnostic developer telemetry platform. It measures actual task time (and AI involvement) by instrumenting **our developers' machines and tools**, never the client's repos, workflows, or Jira. Data flows into our own platform; Jira/Tempo receive human-approved worklogs at the end.

This document is the working spec for building the MVP with Claude Code. Read it fully before starting any phase.

---

## 1. Repo and session strategy

**One monorepo for the entire MVP.** The MCP server, git hooks, ingestion API, and dashboard all share one event schema and one API client. Separate repos would force cross-repo type versioning before we have a single user. Split later only if a component needs its own release cadence (the VS Code extension is the likely first candidate, post-MVP).

**One Claude Code session per phase** (phases in §8). Each session gets a clean context and a narrow goal. Do not build multiple phases in one chat. Start each session with: "Read CLAUDE.md and docs/devpulse-mvp-brief.md, then implement Phase N. Do not start other phases."

**Repository layout** (pnpm workspaces + Turborepo):

```
devpulse/
├── CLAUDE.md                  # session ground rules (template in §9)
├── docs/
│   └── devpulse-mvp-brief.md  # this file
├── apps/
│   └── dashboard/             # Next.js app: UI + all API routes (ingestion + sync)
├── packages/
│   ├── shared/                # zod schemas, event types, API client — single source of truth
│   ├── mcp-server/            # @devpulse/mcp — MCP server + Claude Code hook scripts
│   └── setup-cli/             # npx @devpulse/setup — token, git hooks, MCP config installer
└── infra/
    └── docker-compose.yml     # local Postgres
```

The ingestion API lives inside the Next.js app as route handlers (`app/api/ingest/...`). Do not build a separate API service for the MVP — one deployable unit (Vercel or a single container) is the goal.

**Stack**: TypeScript everywhere. Next.js 14+ (App Router), Postgres, Drizzle ORM, Auth.js (SSO), zod for all payload validation, `@modelcontextprotocol/sdk` for the MCP server. Git hooks are POSIX shell calling a small Node script from `setup-cli` so logic stays in TypeScript.

---

## 2. Non-negotiable constraints

1. **Nothing is ever committed to client repos.** Git hooks install via `core.hooksPath` pointing to `~/.devpulse/hooks/` — never into a repo's `.git/hooks` and never as tracked files.
2. **No code contents leave the dev machine.** Events carry metadata only: repo name, branch, issue key, timestamps, diff stats (files changed, insertions, deletions), session info. Never file contents, diffs, or paths beyond the repo root name.
3. **Dev machines never hold Jira/Tempo credentials.** Only the server holds service-account secrets. Agents on dev machines can only write events to the ingestion API.
4. **Agent tokens are write-only.** A leaked token can submit events, never read anyone's data.
5. **Worklogs reach Tempo only after human approval** in the dashboard (one-click populate). No silent auto-logging in the MVP.
6. **Individual data is visible to the individual; managers see aggregates.** Enforce in queries, not just UI.

---

## 3. Data model (Drizzle / Postgres)

```
users          id, email, name, role ('dev'|'lead'), created_at
agent_tokens   id, user_id, token_hash, label, last_seen_at, revoked_at
events         id, user_id, source ('git_hook'|'mcp'|'cc_hook'|'extension'),
               type (see below), repo, branch, issue_key (nullable),
               ts (client timestamp), received_at, metadata jsonb
task_sessions  id, user_id, issue_key, repo, started_at, ended_at,
               ai_assisted bool, ai_tool text, event_count,
               stitch_version int          # derived, rebuildable
worklog_drafts id, user_id, issue_key, date, seconds, description,
               session_ids jsonb, status ('draft'|'approved'|'synced'|'dismissed'),
               approved_at, synced_at, tempo_worklog_id
jira_connections id, label, base_url, kind ('ours'|'client'), auth jsonb (encrypted),
               tempo_enabled bool
mirror_links   id, internal_issue_key, external_issue_key, jira_connection_id
```

**Event types (MVP set)**: `commit`, `push`, `branch_switch`, `session_start`, `session_end`, `tool_call`, `task_start`, `task_stop`, `heartbeat`.

All event payloads are defined as zod schemas in `packages/shared` and reused by the API (validation), the hooks (construction), and the MCP server. This package is the contract; build it first in Phase 1 and treat changes to it as breaking.

**Canonical issue-key regex** (shared): `\b[A-Z][A-Z0-9_]+-\d+\b`, extracted from branch name first, then commit message.

---

## 4. Component specs

### 4.1 Ingestion API (`apps/dashboard/app/api/ingest`)

- `POST /api/ingest/events` — accepts an array of events (batching), bearer agent-token auth, zod-validated, idempotent via client-generated `event_uuid` (unique index; duplicates return 200 with `skipped`).
- Rate limit per token (generous; it exists to catch runaway loops, not devs).
- `POST /api/ingest/heartbeat` — lightweight; used by editor/extension later.
- Events are append-only. Never mutate; corrections happen at the stitching layer.

### 4.2 Session stitching (server-side job)

Turns raw events into `task_sessions`. MVP algorithm, run on a schedule (cron route or Vercel cron) and re-runnable from scratch (`stitch_version`):

1. Group a user's events by `issue_key` (fallback: repo+branch when no key).
2. A session opens at the first event and closes when a gap exceeds **45 minutes** (constant in shared config) or an explicit `session_end` / `task_stop` arrives.
3. Clamp each session to working hours (default 09:00–18:00, TZ per user, Mon–Fri) for the *reported* seconds; keep raw span too.
4. `ai_assisted = true` if the session contains any event with source `mcp` or `cc_hook`, or any commit whose metadata includes an AI co-author trailer. Record which (`ai_tool`).
5. Nightly, roll each user's sessions into `worklog_drafts` grouped by issue_key + date.

### 4.3 Git hooks + setup CLI (`packages/setup-cli`)

`npx @devpulse/setup` does, idempotently:

1. Device-auth style login: prints a dashboard URL + code; on approval the CLI receives an agent token; stores it in `~/.devpulse/credentials` (0600).
2. Writes hook scripts to `~/.devpulse/hooks/` and sets global `core.hooksPath`. Hooks handled: `post-commit`, `post-checkout` (branch switch), `pre-push`. Each hook execs `node ~/.devpulse/agent.js <type>`, which builds the event (repo basename, branch, issue key, diff stats via `git diff --shortstat`) and POSTs it. **Fire-and-forget with a 2s timeout and local spool file on failure** (retried next invocation) — a hook must never block or break a dev's commit, even fully offline.
3. Writes the MCP server entry into Claude Code and Cursor config files if present.
4. Installs Claude Code hooks config (§4.4).
5. `npx @devpulse/setup status` prints what's installed, token label, last event sent. `--uninstall` reverses everything.

Edge case to handle: devs who already use `core.hooksPath` or husky — our hook scripts must chain-call any pre-existing hooks path if one was set (store the old value, exec it after ours).

### 4.4 MCP server + Claude Code hooks (`packages/mcp-server`)

Runs as stdio MCP server: `npx @devpulse/mcp`. Tools (all thin wrappers that emit events / query the API):

- `task_start(issue_key)` / `task_stop()` — explicit task boundary events.
- `get_my_tasks()` — reads the dev's open drafts/recent issue keys (this is the one read scope agent tokens get: own-data, current-day only).
- `log_context(summary)` — attaches a short human/AI-written summary event to the current session; surfaces later in the draft description.
- `create_ticket(title, description, project)` — creates a **draft ticket** in our DB (not directly in Jira); dashboard approval pushes it out. Keeps constraint 3 intact.

Claude Code hooks (installed by setup CLI into `~/.claude/settings.json`): `SessionStart` and `SessionEnd`/`Stop` emit `session_start`/`session_end` events with cwd repo + branch. Consult current Claude Code hooks documentation during implementation — do not rely on memory for hook event names or config schema.

### 4.5 Dashboard (`apps/dashboard`)

Auth.js with our SSO provider (env-configurable; Google Workspace first). MVP pages:

- **My timeline** — today/this week: stitched sessions per task, AI badge, raw vs clamped time.
- **Drafts** — the core screen. Nightly drafts listed; per-row edit (seconds, description) + approve; "approve all". Approval enqueues sync.
- **Task detail** — estimate (from Jira, if connection configured) vs actual, per ticket.
- **Team view (leads only)** — aggregates: estimate-compression ratio over time, AI-assisted vs not cohort comparison, throughput. No per-individual drill-down in MVP.
- **Settings** — agent tokens (issue/revoke, last-seen), working hours + TZ, connected editors status.

Keep the UI minimal (shadcn/ui is fine). The charts that matter: compression ratio trend, AI vs non-AI cohort bars.

### 4.6 Jira/Tempo sync (`apps/dashboard/app/api/sync` + worker route)

- Adapter interface: `resolveIssue(key)`, `createIssue(draft)`, `pushWorklog(draft)`. MVP implements one adapter: **our Jira Cloud + Tempo v4** (worklogs need numeric issue id — resolve via Jira API; verify current Tempo API docs during implementation).
- Mirror tickets: if a draft's issue key belongs to a client project with no connection, create/find a mirror ticket in our Jira (label `devpulse-mirror`, custom field or description line holding the external key via `mirror_links`), and log time against the mirror.
- Every synced worklog description is tagged `[devpulse]` + draft id for idempotency; sync retries are safe.
- Client Jira adapters: **out of scope for MVP** — but the adapter interface ships so they slot in later.

### 4.7 VS Code / Cursor extension

**Out of MVP scope.** Post-MVP phase 6: thin extension (status bar current task, task quick-pick, "drafts ready" notification, runs setup CLI on first launch). Noted here so nothing in the MVP blocks it: the heartbeat endpoint and own-data read scope already exist for it.

---

## 5. Auth summary

- Dashboard: Auth.js SSO, session cookies, `role` gates team views.
- Agents: per-dev bearer tokens, hashed at rest (sha256), write-only + own-current-day read for `get_my_tasks`, revocable, `last_seen_at` maintained.
- Outbound: Jira/Tempo service-account creds in server env / encrypted `jira_connections.auth`; never sent to clients or dev machines.
- Audit: append `audit_log` rows on token issue/revoke, draft approval, sync push.

## 6. Privacy commitments (publish to the team)

Captured: timestamps, repo/branch names, issue keys, diff stats, session/tool metadata, optional summaries the dev's agent submits. Not captured: code contents, diffs, file paths, keystrokes, screenshots, prompt contents. Individual data visible to the individual; leads see aggregates only.

## 7. Environment variables

```
DATABASE_URL, AUTH_SECRET, AUTH_GOOGLE_ID/SECRET (or chosen SSO),
APP_URL,
JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN,        # our instance service account
TEMPO_API_TOKEN,
STITCH_GAP_MINUTES=45, DEFAULT_TZ=Asia/Manila,
WORKDAY_START=09:00, WORKDAY_END=18:00
```

---

## 8. Build phases (one Claude Code session each)

Each phase ends with its acceptance checks passing and a short `docs/phase-N-notes.md` describing decisions made, so the next session can read it.

**Phase 1 — Foundation: monorepo, shared schema, DB, ingestion API.**
Scaffold workspaces; `packages/shared` (event zod schemas, issue-key regex, API client); Drizzle schema + migrations; docker-compose Postgres; `POST /api/ingest/events` with token auth, idempotency, batching; seed script creating a user + token.
*Accept:* `curl` with a seeded token inserts events; duplicate `event_uuid` skips; invalid payloads 400 with zod errors; unit tests for schemas + key extraction.

**Phase 2 — Setup CLI + git hooks.**
Device-auth token flow (dashboard side can be a minimal API route now, UI later); hooks install with `core.hooksPath` + chaining of pre-existing path; agent.js event construction; offline spool + retry; `status` and `--uninstall`.
*Accept:* in a scratch repo, commits/branch switches/pushes appear as events; committing works offline; uninstall restores prior hooksPath.

**Phase 3 — MCP server + Claude Code hooks.**
Tools per §4.4; stdio server; hooks config installed by setup CLI; events flow with source `mcp`/`cc_hook`.
*Accept:* server passes MCP inspector; `task_start` from a Claude Code session creates an event; SessionStart/End events arrive with repo+branch.

**Phase 4 — Stitching + dashboard (read-only).**
Stitching job per §4.2 with tests (gap handling, working-hours clamp, AI flag); Auth.js SSO; My timeline, Task detail, Settings(tokens); team aggregates page.
*Accept:* seeded raw events produce expected sessions in tests; a dev sees only their own sessions; re-running stitching from scratch is deterministic.

**Phase 5 — Drafts + one-click populate + Tempo sync.**
Nightly draft rollup; Drafts screen with edit/approve; sync worker with our-Jira adapter, mirror-ticket logic, `[devpulse]` idempotency tag.
*Accept:* approving a draft creates a Tempo worklog against the right (or mirror) ticket exactly once, retries safe; dismissed drafts never sync.

**Post-MVP (separate briefs later):** Phase 6 VS Code/Cursor extension · Phase 7 client Jira adapters · Phase 8 deeper AI-attribution (commit trailers analysis, Cursor hooks as their support matures).

---

## 9. CLAUDE.md template (place at repo root)

```md
# DevPulse
Client-agnostic dev telemetry. Full spec: docs/devpulse-mvp-brief.md — read it first.

## Rules
- TypeScript strict; zod-validate every external payload; schemas live ONLY in packages/shared.
- Never log or store code contents, diffs, file paths, or prompts — metadata only (spec §2).
- Git hooks must never block a commit: 2s timeout, spool on failure.
- Agent tokens: write-only (+ own-current-day read for get_my_tasks). Jira/Tempo creds server-side only.
- pnpm + turborepo. Tests with vitest; every phase's acceptance checks become tests.
- Verify current docs for external APIs (Tempo v4, Jira Cloud, MCP SDK, Claude Code hooks) rather than assuming.
- Work only on the phase named in the prompt; write docs/phase-N-notes.md when done.
```

## 10. Explicitly out of MVP scope

Client Jira write-back · VS Code/Cursor extension · GitHub API polling of client orgs · automatic (unapproved) time logging · per-individual manager drill-downs · Slack/calendar signals · mobile.