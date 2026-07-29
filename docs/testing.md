# Testing MnlDevTelemetry locally

How to run and manually verify the platform on your machine. Phase 1 covers the
ingestion API; later phases append their own sections.

## Prerequisites

- Node 20+ and pnpm 10 (`corepack enable` if pnpm is missing).
- Docker Desktop running (menu-bar whale icon steady, not animating). Start it
  with `open -a Docker` if needed.
- Dependencies installed once: `pnpm install`.

---

## Phase 1 — Ingestion API

### 1. Start Postgres

From the repo root:

```bash
pnpm db:up
```

Confirm it's accepting connections:

```bash
docker exec devpulse-postgres pg_isready -U devpulse -d devpulse
```

### 2. Apply the schema (idempotent)

```bash
pnpm db:migrate
```

### 3. Seed a user + agent token

The token is printed only once, so run this whenever you need a fresh one:

```bash
pnpm db:seed
```

Copy the `dp_...` line from the output.

### 4. Start the API server

Leave this running in the foreground; open a second terminal for the curls.

```bash
pnpm --filter @mnl-dev-telemetry/dashboard dev
```

Wait for `✓ Ready`.

### 5. Acceptance curls (second terminal)

Paste your token from step 3:

```bash
export TOKEN=dp_PASTE_YOUR_TOKEN_HERE
```

**A — valid event inserts** (expect `200 {"inserted":1,...}`):

```bash
curl -s -X POST http://localhost:3000/api/ingest/events -H "authorization: Bearer $TOKEN" -H "content-type: application/json" -d "{\"events\":[{\"event_uuid\":\"$(uuidgen|tr A-Z a-z)\",\"source\":\"git_hook\",\"type\":\"commit\",\"ts\":\"2026-07-23T09:00:00.000Z\",\"repo\":\"mnl-dev-telemetry\",\"branch\":\"feature/ABC-123\"}]}"
```

**B — duplicate is skipped** (sends a fixed UUID twice; second returns `"skipped":1`):

```bash
U=11111111-1111-4111-8111-111111111111; for i in 1 2; do curl -s -X POST http://localhost:3000/api/ingest/events -H "authorization: Bearer $TOKEN" -H "content-type: application/json" -d "{\"events\":[{\"event_uuid\":\"$U\",\"source\":\"git_hook\",\"type\":\"commit\",\"ts\":\"2026-07-23T09:00:00.000Z\",\"repo\":\"mnl-dev-telemetry\",\"branch\":\"main\"}]}"; echo; done
```

**C — invalid payload** (expect `400` with zod `issues`):

```bash
curl -s -X POST http://localhost:3000/api/ingest/events -H "authorization: Bearer $TOKEN" -H "content-type: application/json" -d '{"events":[{"event_uuid":"not-a-uuid","source":"git_hook","type":"commit","ts":"2026-07-23T09:00:00.000Z","issue_key":"bad-1"}]}'
```

**D — bad token** (expect `401`):

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/ingest/events -H "authorization: Bearer dp_nope" -H "content-type: application/json" -d '{"events":[]}'
```

### 6. Inspect stored data (optional)

```bash
docker exec devpulse-postgres psql -U devpulse -d devpulse -c "select type, repo, branch, issue_key, metadata from events order by received_at;"
```

`issue_key` should be `ABC-123` even though you never sent it (derived from the
branch), and `metadata` should contain only known fields — unknown keys such as
a file path are stripped before storage (privacy §2).

### 7. Unit tests

No server or DB required — these are pure unit tests:

```bash
pnpm test
```

Expect **192 passing** (31 shared + 49 dashboard + 28 setup-cli + 84
vscode-extension).

### 8. Shut down

`Ctrl+C` the dev server, then stop Postgres (keeps the data volume):

```bash
pnpm db:down
```

To wipe the database completely (drops the volume):

```bash
docker compose -f infra/docker-compose.yml down -v
```

---

## Phase 6 — VS Code extension (manual UI checklist)

Activation latency, state detection, every status bar state, branch switching and
uninstall are covered by `pnpm --filter mnl-dev-telemetry-vscode test`. What only a real
editor can show is the browser hand-off and the visual result — that's this list.

### Setup

Run the dashboard (steps 1–4 above, with `DEV_LOGIN_ENABLED=true`), then open
**`packages/vscode-extension`** as its own window and press <kbd>F5</kbd>. The
launch config points `DEVPULSE_HOME` and `GIT_CONFIG_GLOBAL` at
`.devpulse-dev/` inside the package, so nothing below touches your real install
or global git config. In the dev host, set `mnlDevTelemetry.dashboardUrl` to
`http://localhost:3000`.

To test the packaged artefact instead:
`pnpm --filter mnl-dev-telemetry-vscode package` then install the `.vsix` — but that one
*does* use your real `~/.devpulse`, so run `MnlDevTelemetry: Uninstall from this
machine` when you're done (or skip it if you're already set up for real).

### Checklist

| # | Do | Expect |
|---|---|---|
| 1 | Open the dev host on a repo with a branch like `TEX-123-thing` | Status bar shows `$(pulse) MnlDevTelemetry: Set up`; a notification offers **Enable MnlDevTelemetry** |
| 2 | Click **Enable MnlDevTelemetry** | Progress notification "setting up this machine", then a message with an 8-char code and **Open activation page** |
| 3 | Click **Open activation page** | Browser opens `/activate`; the code is already in your clipboard — paste and approve as yourself |
| 4 | Watch the editor | Progress clears; "MnlDevTelemetry is active…" with **Open dashboard**; status bar becomes `$(pulse) TEX-123` |
| 5 | Hover the status bar item | Dashboard link, token label (your hostname), "Last event sent: none yet" |
| 6 | Click the status bar item | Browser opens `/tasks/TEX-123` |
| 7 | Commit something in that repo, then hover again (or wait ≤60 s) | "Last event sent: just now from `post-commit`" |
| 8 | `git checkout main` | Status bar becomes `$(pulse) MnlDevTelemetry: no ticket` on a yellow background; tooltip explains the `TEX-123-short-description` convention. No reload needed |
| 9 | `git checkout -` | Back to `$(pulse) TEX-123` |
| 10 | Palette → `MnlDevTelemetry: Show status` | Output channel opens with `state: active`, hooks list, `← MnlDevTelemetry`, and **no token value** |
| 11 | Cancel the progress notification mid-setup (repeat from step 2 on a fresh machine/scratch home) | "MnlDevTelemetry setup cancelled…"; no further polling |
| 12 | Palette → `MnlDevTelemetry: Uninstall from this machine` → **Uninstall** | Modal confirms first; then "MnlDevTelemetry removed"; status bar back to `Set up`; `git config --global core.hooksPath` restored to whatever it was |
| 13 | Reload the window with MnlDevTelemetry active | Status bar populates immediately, no visible startup delay |

Refresh the dashboard timeline after step 7 — pages re-stitch on load, so the
commit shows up without waiting for cron.

### Heartbeats (the accuracy fix)

The idle rule, the payload and the pacing are all unit- and integration-tested,
and the endpoint itself is `curl`-verifiable without any editor:

```bash
# 401 without a token
curl -s -o /dev/stdout -w " HTTP %{http_code}\n" \
  -X POST http://localhost:3000/api/ingest/heartbeat \
  -H 'content-type: application/json' \
  -d '{"event_uuid":"eb21a3b7-2066-4db7-99df-375675a95147","ts":"2026-07-29T02:00:00.000Z","repo":"acme-web","branch":"TEX-123-x"}'
```

```bash
# 200 {"inserted":1,...} with a seeded token; run twice to see skipped:1
curl -s -X POST http://localhost:3000/api/ingest/heartbeat \
  -H "authorization: Bearer $MNL_DEV_TELEMETRY_TOKEN" -H 'content-type: application/json' \
  -d '{"event_uuid":"eb21a3b7-2066-4db7-99df-375675a95147","ts":"2026-07-29T02:00:00.000Z","repo":"acme-web","branch":"TEX-123-x"}'
```

What's worth checking by hand in the editor:

| # | Do | Expect |
|---|---|---|
| H1 | With MnlDevTelemetry active, run `MnlDevTelemetry: Show status` | `heartbeat: on — every 5 min while editing, stops after 5 min idle` |
| H2 | Hover the status bar item | Tooltip discloses "Heartbeat: every 5 min while you're editing — repo + branch only" |
| H3 | Edit a file in a git repo, wait ~5 min, then check the DB (query below) | One `heartbeat` row, `source=extension`, repo + branch only, `metadata={}` |
| H4 | Keep editing for 20 minutes | ~4–5 rows, one per interval — not one per keystroke |
| H5 | Stop touching the editor for 20 minutes (leave it open) | **No new rows.** This is the check that matters most |
| H6 | Type again | Pings resume within a minute |
| H7 | Run `MnlDevTelemetry: Uninstall from this machine` | Status shows `heartbeat: off`; no further rows |

```bash
docker exec devpulse-postgres psql -U devpulse -d devpulse \
  -c "select ts, repo, branch, issue_key, metadata from events where type='heartbeat' order by ts desc limit 10;"
```

Patience is optional: temporarily lower `HEARTBEAT_INTERVAL_MINUTES` and
`HEARTBEAT_IDLE_MINUTES` in `packages/shared/src/config.ts` (to 1) and rebuild —
the shared constants drive both the sender and the tests.

**The headline check** — that work before a commit stops reading as zero:

```bash
# in a TEX-xxx-* branch: edit, let a ping or two land, then commit once
git commit -am "wip"
curl -s -X POST http://localhost:3000/api/cron/stitch; echo
docker exec devpulse-postgres psql -U devpulse -d devpulse \
  -c "select issue_key, started_at::time, ended_at::time, event_count, reported_seconds/60 as min from task_sessions order by started_at desc limit 5;"
```

The session must start at the first heartbeat, not at the commit. Note the
session only earns *reported* minutes inside working hours (09:00–18:00 in the
user's tz) — a late-night test will correctly show 0 reported despite a real raw
span.

---

## Notes

- `pnpm db:down` preserves the `devpulse-pgdata` volume, so your seeded user,
  token and events survive a restart. Use `down -v` to start clean.
- Local env lives in `apps/dashboard/.env` (gitignored); see `.env.example` for
  the full list of variables.
