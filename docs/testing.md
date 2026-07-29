# Testing DevPulse locally

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
pnpm --filter @devpulse/dashboard dev
```

Wait for `✓ Ready`.

### 5. Acceptance curls (second terminal)

Paste your token from step 3:

```bash
export TOKEN=dp_PASTE_YOUR_TOKEN_HERE
```

**A — valid event inserts** (expect `200 {"inserted":1,...}`):

```bash
curl -s -X POST http://localhost:3000/api/ingest/events -H "authorization: Bearer $TOKEN" -H "content-type: application/json" -d "{\"events\":[{\"event_uuid\":\"$(uuidgen|tr A-Z a-z)\",\"source\":\"git_hook\",\"type\":\"commit\",\"ts\":\"2026-07-23T09:00:00.000Z\",\"repo\":\"devpulse\",\"branch\":\"feature/ABC-123\"}]}"
```

**B — duplicate is skipped** (sends a fixed UUID twice; second returns `"skipped":1`):

```bash
U=11111111-1111-4111-8111-111111111111; for i in 1 2; do curl -s -X POST http://localhost:3000/api/ingest/events -H "authorization: Bearer $TOKEN" -H "content-type: application/json" -d "{\"events\":[{\"event_uuid\":\"$U\",\"source\":\"git_hook\",\"type\":\"commit\",\"ts\":\"2026-07-23T09:00:00.000Z\",\"repo\":\"devpulse\",\"branch\":\"main\"}]}"; echo; done
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

Expect **140 passing** (21 shared + 37 dashboard + 28 setup-cli + 54
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
uninstall are covered by `pnpm --filter devpulse-vscode test`. What only a real
editor can show is the browser hand-off and the visual result — that's this list.

### Setup

Run the dashboard (steps 1–4 above, with `DEV_LOGIN_ENABLED=true`), then open
**`packages/vscode-extension`** as its own window and press <kbd>F5</kbd>. The
launch config points `DEVPULSE_HOME` and `GIT_CONFIG_GLOBAL` at
`.devpulse-dev/` inside the package, so nothing below touches your real install
or global git config. In the dev host, set `devpulse.dashboardUrl` to
`http://localhost:3000`.

To test the packaged artefact instead:
`pnpm --filter devpulse-vscode package` then install the `.vsix` — but that one
*does* use your real `~/.devpulse`, so run `DevPulse: Uninstall from this
machine` when you're done (or skip it if you're already set up for real).

### Checklist

| # | Do | Expect |
|---|---|---|
| 1 | Open the dev host on a repo with a branch like `TEX-123-thing` | Status bar shows `$(pulse) DevPulse: Set up`; a notification offers **Enable DevPulse** |
| 2 | Click **Enable DevPulse** | Progress notification "setting up this machine", then a message with an 8-char code and **Open activation page** |
| 3 | Click **Open activation page** | Browser opens `/activate`; the code is already in your clipboard — paste and approve as yourself |
| 4 | Watch the editor | Progress clears; "DevPulse is active…" with **Open dashboard**; status bar becomes `$(pulse) TEX-123` |
| 5 | Hover the status bar item | Dashboard link, token label (your hostname), "Last event sent: none yet" |
| 6 | Click the status bar item | Browser opens `/tasks/TEX-123` |
| 7 | Commit something in that repo, then hover again (or wait ≤60 s) | "Last event sent: just now from `post-commit`" |
| 8 | `git checkout main` | Status bar becomes `$(pulse) DevPulse: no ticket` on a yellow background; tooltip explains the `TEX-123-short-description` convention. No reload needed |
| 9 | `git checkout -` | Back to `$(pulse) TEX-123` |
| 10 | Palette → `DevPulse: Show status` | Output channel opens with `state: active`, hooks list, `← DevPulse`, and **no token value** |
| 11 | Cancel the progress notification mid-setup (repeat from step 2 on a fresh machine/scratch home) | "DevPulse setup cancelled…"; no further polling |
| 12 | Palette → `DevPulse: Uninstall from this machine` → **Uninstall** | Modal confirms first; then "DevPulse removed"; status bar back to `Set up`; `git config --global core.hooksPath` restored to whatever it was |
| 13 | Reload the window with DevPulse active | Status bar populates immediately, no visible startup delay |

Refresh the dashboard timeline after step 7 — pages re-stitch on load, so the
commit shows up without waiting for cron.

---

## Notes

- `pnpm db:down` preserves the `devpulse-pgdata` volume, so your seeded user,
  token and events survive a restart. Use `down -v` to start clean.
- Local env lives in `apps/dashboard/.env` (gitignored); see `.env.example` for
  the full list of variables.
