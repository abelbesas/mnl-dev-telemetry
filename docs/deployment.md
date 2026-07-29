# Deploying MnlDevTelemetry (Vercel) — early team-testing runbook

Not a build phase — deployment is cross-cutting ops. This is the minimum path to
a shared URL so other devs can attach their machines and test *now*, using the
dev-login shortcut for auth. Harden to Google SSO before anyone treats the data
as real (see "Auth" below).

The dashboard is one Next.js app (UI + all API routes), so **one Vercel project**
deploys the whole thing. The setup CLI stays a local tool your teammates run,
pointed at the deployed URL.

---

## 0. What changes vs. local

| Local | Deployed |
|---|---|
| `--url http://localhost:3000` | `--url https://<your-app>.vercel.app` |
| Docker Postgres | Hosted Postgres (Neon / Vercel Postgres / Supabase) |
| `pnpm db:migrate` against Docker | `pnpm db:migrate` with `DATABASE_URL` = hosted DB |
| `APP_URL=http://localhost:3000` | `APP_URL=https://<your-app>.vercel.app` (drives the CLI's `/activate` link) |
| stitch by hand / cron route | Vercel Cron (`vercel.json`) + manual trigger |
| `.env` file | Vercel Project → Environment Variables |

The app auto-applies TLS + a small serverless-safe connection pool for any
non-`localhost` `DATABASE_URL` (see `src/db/connection.ts`), so no code change is
needed to switch databases — just the env var.

---

## 1. GitHub — host the repo (this is all "GitHub" means here)

Vercel deploys from a Git repo. GitHub is only the source host — **no GitHub
OAuth is involved** unless you later choose GitHub *login* (optional, §Auth).

```bash
git add -A && git commit -m "chore: prep for Vercel deploy"
# create an empty private repo on github.com first, then:
git remote add origin git@github.com:<you>/mnl-dev-telemetry.git
git push -u origin main
```

## 2. Hosted Postgres

Any Postgres works. Easiest with Vercel is **Neon** (Vercel Postgres is Neon):

1. Create a Neon project (or Vercel → Storage → Create → Postgres).
2. Grab **two** connection strings:
   - **Pooled** (host contains `-pooler`) → the app's `DATABASE_URL`.
   - **Direct** (no `-pooler`) → used only for running migrations.
   Both end with `?sslmode=require`.

Apply the schema from your laptop against the **direct** URL:

```bash
DATABASE_URL='postgres://…direct…/db?sslmode=require' pnpm db:migrate
```

(Optional) load demo data so the dashboard isn't empty for the first look —
`seed-demo` refuses `NODE_ENV=production`, and running it locally isn't
production, so:

```bash
DATABASE_URL='postgres://…direct…/db?sslmode=require' pnpm db:seed:demo
```

## 3. Vercel — import the project

Vercel → Add New → Project → import the GitHub repo, then:

- **Root Directory:** `apps/dashboard` (this is the monorepo app). Vercel detects
  pnpm + the workspace at the repo root automatically.
- **Framework:** Next.js (auto). Build/install commands: leave default.
- **Environment Variables** (Production + Preview):

  | Key | Value |
  |---|---|
  | `DATABASE_URL` | the **pooled** Neon string (`…-pooler…?sslmode=require`) |
  | `AUTH_SECRET` | `openssl rand -base64 32` |
  | `APP_URL` | `https://<your-app>.vercel.app` |
  | `AUTH_URL` | `https://<your-app>.vercel.app` |
  | `DEV_LOGIN_ENABLED` | `true` (early testing — see Auth) |
  | `CRON_SECRET` | `openssl rand -base64 32` (Vercel sends it to the cron route) |

- Deploy. Note the final URL; if it differs from what you guessed, update
  `APP_URL`/`AUTH_URL` and redeploy (they must match the real origin).

`apps/dashboard/vercel.json` registers a **daily** stitch cron (`0 3 * * *`) —
Hobby-compatible (Hobby allows only once-per-day crons). You rarely need it,
though: the timeline, task, and team pages **re-stitch on load**, so a commit
shows up the moment you refresh. The cron is just a nightly safety net; you can
also trigger a full rebuild manually anytime (below), and it's idempotent.

## 4. Smoke test the deployment

```bash
# stitch trigger (needs the secret you set)
curl -s -X POST https://<your-app>.vercel.app/api/cron/stitch \
  -H "authorization: Bearer $CRON_SECRET"; echo
```

Open `https://<your-app>.vercel.app`, sign in with your email (dev-login
auto-provisions you), and confirm the timeline/team pages render.

---

## 5. Onboard a teammate (the payoff)

Two paths. **Prefer the VS Code extension** — it's one file to share and one
click to run. The raw CLI stays supported for anyone not in VS Code / Cursor.

### 5a. VS Code / Cursor extension (recommended)

Build the `.vsix` once and share the file (Slack, GitHub release). No
marketplace, no approval:

```bash
pnpm install
pnpm --filter mnl-dev-telemetry-vscode package
# → packages/vscode-extension/mnl-dev-telemetry-vscode-0.2.0.vsix
```

On their machine:

1. Install it — Extensions panel → `···` → **Install from VSIX…**, or:
   ```bash
   code --install-extension mnl-dev-telemetry-vscode-0.2.0.vsix
   ```
   (Cursor: same panel.)
2. If the deployed URL isn't the packaged default, set **`mnlDevTelemetry.dashboardUrl`**
   in Settings to `https://<your-app>.vercel.app`. The default is
   `https://mnl-dev-telemetry-dashboard.vercel.app`, so rebuild the VSIX with a
   new default if your team's URL differs and you'd rather not have them set it.
3. Click **Enable MnlDevTelemetry** in the notification (or run
   `MnlDevTelemetry: Enable MnlDevTelemetry on this machine` from the palette). The progress
   notification shows a code — already copied to their clipboard — with an
   **Open activation page** button.
4. They sign in **as themselves** (their email), paste the code, approve → the
   agent token binds to their user and lands in `~/.devpulse/credentials` (0600).
5. The status bar shows the current branch's ticket (e.g. `TEX-123`). They commit
   in **any** repo (nothing is added to the repo) → events flow to the deployed
   dashboard; the timeline/task pages re-stitch on load, so a refresh shows it.
6. **Heartbeats start automatically** — a ping every 5 minutes while they're
   editing, so their sessions start when work started instead of at the first
   commit. Nothing to configure; it stops after 5 minutes idle.

Uninstall from the palette: `MnlDevTelemetry: Uninstall from this machine` (restores any
prior global hooks path). Removing the *extension* does not stop telemetry — the
git hooks are machine-global; run the uninstall command first.

For setup the extension does exactly what the CLI does — it imports the same
install/uninstall code and ships the same `agent.js` (verified byte-identical,
docs/phase-6-notes.md). The one thing it adds is the heartbeat, which carries repo
basename + branch + timestamp and nothing else. It reads no code.

**Editor users get materially better numbers than CLI-only users**, because
git-only data starts a session at the first commit and ends it at the last. If
accuracy matters for someone's tickets, get them on the extension.

### 5b. Raw CLI (fallback — no VS Code, or scripted setup)

Because the CLI bundles are self-contained (`dist/cli.js` + `dist/agent.js` run
with bare `node`, no `node_modules`), a teammate needs **no repo checkout**:

1. Build once and hand them the two files (same folder), or have them clone +
   `pnpm --filter @mnl-dev-telemetry/setup build`:
   ```bash
   pnpm --filter @mnl-dev-telemetry/setup build   # → packages/setup-cli/dist/{cli,agent}.js
   ```
2. On their machine:
   ```bash
   node cli.js install --url https://<your-app>.vercel.app --label "$(hostname)"
   ```
3. They open the printed `/activate` link, sign in **as themselves** (their
   email), and approve → the agent token binds to their user.
4. They commit in **any** repo (nothing added to the repo) → events flow to the
   deployed dashboard. Trigger a stitch (or wait for cron) and their timeline
   fills in.

`node cli.js status` shows what's installed; `node cli.js uninstall` reverses it
(restores prior global hooks path). Mixing paths is fine — both write the same
`~/.devpulse`, and installs are idempotent.

---

## Auth: dev-login now vs. SSO later

- **Now (fastest):** `DEV_LOGIN_ENABLED=true`. Any email signs in, no password.
  Real tradeoff — anyone who reaches the URL can sign in as any email. For an
  internal early test, pair it with **Vercel → Settings → Deployment Protection**
  (password / SSO / trusted IPs) so only your team can reach the site at all.
- **Later (proper, spec §5):** create a Google OAuth client, set
  `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`, add the redirect URI
  `https://<your-app>.vercel.app/api/auth/callback/google` and JS origin
  `https://<your-app>.vercel.app`, then set `DEV_LOGIN_ENABLED=false`. First SSO
  sign-in auto-creates the user as a `dev`. (Want GitHub login instead? It's a
  one-provider add in `src/auth.ts` — ask.)

Promote someone to lead (to see the Team view) against the hosted DB:

```bash
DATABASE_URL='…direct…' pnpm --filter @mnl-dev-telemetry/dashboard exec tsx -e \
  "import {drizzle} from 'drizzle-orm/postgres-js';import postgres from 'postgres';import {sql} from 'drizzle-orm';const s=postgres(process.env.DATABASE_URL,{ssl:'require',max:1});await drizzle(s).execute(sql\`update users set role='lead' where email='YOU@company.com'\`);await s.end();"
```

(or just run the `update users …` statement in Neon's SQL console.)

## Notes / gotchas

- **Pooled URL for the app, direct URL for migrations.** DDL over a transaction
  pooler can misbehave; the app over a session/pool is fine (`prepare:false` is
  set automatically for hosted URLs).
- **`APP_URL` must equal the real deployed origin**, or the CLI prints a wrong
  `/activate` link.
- **Preview deployments** get their own URL; the CLI/`APP_URL` should target your
  stable production domain, not per-PR preview URLs.
- Events are still **metadata only** (spec §2) — deploying changes where they're
  stored, not what's collected.
