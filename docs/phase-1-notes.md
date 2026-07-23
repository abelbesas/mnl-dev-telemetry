# Phase 1 — Foundation notes

Scope delivered: monorepo scaffold, `packages/shared` contract, full Drizzle
schema + migration, docker-compose Postgres, `POST /api/ingest/events`, seed
script. All acceptance checks pass. No later-phase work started.

## Layout

```
package.json / pnpm-workspace.yaml / turbo.json / tsconfig.base.json
infra/docker-compose.yml            # Postgres 16
packages/shared/                    # zod schemas, issue-key, API client, token helpers
apps/dashboard/                     # Next.js 15 app — ingestion route + DB + seed
```

## Key decisions

- **zod v3, not v4.** Pinned `zod@^3.23` for the well-understood API
  (`.datetime()`, `.uuid()`, `error.issues`) and ecosystem stability. Revisit
  when drizzle-zod / the stack settle on v4.
- **`packages/shared` ships as TypeScript source** (`main` → `src/index.ts`), no
  build step. Consumed via `transpilePackages` in Next and directly by vitest /
  tsx. Avoids build-ordering pain for a single-consumer MVP. Add a `tsup` build
  later only if a plain-`node` consumer (e.g. the git hook in Phase 2) needs it.
- **Module resolution `Bundler` + extensionless imports** across the repo — works
  with Next, vitest and tsx uniformly.
- **Event schema is a zod discriminated union on `type`.** Objects use zod's
  default key-stripping, which doubles as a privacy guard (spec §2): unknown
  metadata keys such as `file_path` are dropped, never stored. Verified with a
  live curl (a `file_path` field was stripped before insert).
  - `task_start` requires `issue_key`; `tool_call` requires `metadata.tool`.
- **Full data model migrated now** (all 8 tables from §3 + `audit_log` from §5),
  even though only `users` / `agent_tokens` / `events` are used this phase, so
  later phases add rows rather than reshaping migrations. Added `created_at` to
  `agent_tokens` (convenience); everything else matches §3 exactly.
- **`repo` / `branch` nullable** on `events` to accommodate repo-less events
  (heartbeat, task_start). Only `issue_key` was marked nullable in §3, but the
  event set requires the others to be optional too.
- **Idempotency**: `event_uuid` has a unique index; insert uses
  `ON CONFLICT (event_uuid) DO NOTHING ... RETURNING`. Intra-batch duplicates are
  de-duped in code first (kept-first), so both cross-request and in-batch
  duplicates report as `skipped`.
- **Auth**: bearer token → sha256 → `agent_tokens` lookup (non-revoked). Server
  derives `user_id` from the token; clients never send it (spec §4, write-only).
  `last_seen_at` is touched on every authenticated request.
- **Rate limiter** is in-memory per-token fixed-window (300 req / 60s). Single
  instance only — swap for a shared store if the dashboard is scaled out.
- **DB client is lazy** (`getDb()`) so importing the route at build time doesn't
  require `DATABASE_URL`; globally cached to survive dev hot-reload.

## Run it

```bash
pnpm install
pnpm db:up            # Postgres 16 in Docker (needs Docker running)
pnpm db:generate      # regenerate migration from schema (already committed)
pnpm db:migrate
pnpm db:seed          # prints a one-time plaintext agent token
pnpm --filter @devpulse/dashboard dev
pnpm test             # 31 tests (21 shared, 10 dashboard)
```

## Acceptance — verified

- Valid batch with seeded token inserts events → `200 {inserted, skipped}`.
- Duplicate `event_uuid` → `200 {inserted:0, skipped:1, skipped_uuids:[...]}`.
- Invalid payload (bad uuid, bad issue key) → `400` with zod `issues[]`.
- Missing / bad token → `401`.
- Unit tests: schema validation + issue-key extraction (+ ingest helpers,
  rate limiter). `pnpm test` green.
- Confirmed in Postgres: issue key derived from branch (`feature/ABC-123` →
  `ABC-123`), unknown metadata key stripped, `last_seen_at` set.

## For Phase 2

- `IngestClient` (`packages/shared/src/client.ts`) is ready for the git hooks,
  with a `timeoutMs` option for the 2s hook budget.
- `generateAgentToken` / `hashAgentToken` are in shared for the device-auth flow.
- `.env.example` documents all env vars; local `apps/dashboard/.env` is
  gitignored.
