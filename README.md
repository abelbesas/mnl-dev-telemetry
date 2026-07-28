# DevPulse

Client-agnostic developer telemetry. It measures real task time (and how much of it was AI-assisted) by instrumenting **our** machines and tools — never a client's repos, workflows, or Jira. Events land in our own Postgres; Jira/Tempo only ever receive human-approved worklogs.

Full spec: [`docs/devpulse-mvp-brief.md`](docs/devpulse-mvp-brief.md).

## What's here

```
apps/dashboard/       Next.js app — UI + ingestion/auth/cron API routes, Drizzle schema
packages/shared/      zod event schemas, issue-key regex, API client (the contract)
packages/setup-cli/   npx @devpulse/setup — device-auth login, global git hooks, event agent
infra/                docker-compose.yml (local Postgres)
docs/                 spec, phase notes, deployment + testing guides
```

## Status

| Phase | Scope | State |
| --- | --- | --- |
| 1 | Monorepo, shared schemas, DB, `POST /api/ingest/events` | done |
| 2 | Setup CLI, global git hooks, offline spool | done |
| 3 | MCP server + Claude Code hooks | not started |
| 4 | Session stitching, Auth.js SSO, timeline/task/team/settings | done |
| 5 | Nightly drafts, approve UI, Tempo sync | not started |

Phase notes: [`docs/phase-1-notes.md`](docs/phase-1-notes.md) · [`docs/phase-2-notes.md`](docs/phase-2-notes.md) · [`docs/phase-4-notes.md`](docs/phase-4-notes.md)

## Quick start

Requires Node ≥ 20, pnpm 10, Docker.

```bash
pnpm install
cp .env.example .env          # set AUTH_SECRET, DEV_LOGIN_ENABLED=true for local
pnpm db:up && pnpm db:migrate
pnpm db:seed:demo             # 3 devs + 1 lead, ~2.5 weeks of events
pnpm --filter @devpulse/dashboard dev   # http://localhost:3000
```

Sign in with dev login as `alice@devpulse.local` (dev view) or `dana@devpulse.local` (lead view). The demo walkthrough is at the end of `docs/phase-4-notes.md`.

## Scripts

```bash
pnpm test         # vitest across all packages
pnpm typecheck    # tsc --noEmit
pnpm build        # turbo build
pnpm db:up / db:down / db:migrate / db:generate / db:seed / db:seed:demo
```

See [`docs/testing.md`](docs/testing.md) for manual verification flows and [`docs/deployment.md`](docs/deployment.md) for hosting.

## Ground rules

- Metadata only: timestamps, repo/branch names, issue keys, diff stats, session info. Never code, diffs, file paths, or prompts.
- Nothing is written into client repos — hooks install to `~/.devpulse/hooks/` via global `core.hooksPath`, and chain any pre-existing hooks path.
- Git hooks never block a commit: 2s timeout, spool locally and retry on the next invocation.
- Agent tokens are write-only (plus own-current-day reads). Jira/Tempo credentials stay server-side.
- Individuals see their own data; leads see aggregates only, enforced in queries.
- All external payloads are zod-validated, and every schema lives only in `packages/shared`.
