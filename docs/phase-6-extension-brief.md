# Phase 6 — VS Code extension brief (`packages/vscode-extension`)

> Self-contained working brief for a fresh Claude Code session. Start that
> session with: *"Read CLAUDE.md, docs/devpulse-mvp-brief.md, and
> docs/phase-6-extension-brief.md, then implement Phase 6. Do not start other
> phases."* Also skim docs/phase-2-notes.md (setup CLI internals) and
> docs/phase-4-notes.md (dashboard/auth) — the extension wraps both.

## 1. Why / context

DevPulse is being demoed off a live Vercel deployment
(`https://mnl-dev-telemetry-dashboard.vercel.app`). Onboarding today means
handing teammates two bundled files (`cli.js`, `agent.js`) and a terminal
command. That works but demos poorly and adds friction. Phase 6 (spec §4.7,
pulled forward for the demo) replaces that with: **install one VS Code
extension → click "Enable DevPulse" → approve in browser → done.**

For **setup and visibility**, the extension is deliberately a **thin UI wrapper
around the existing setup CLI**. It must not reimplement device-auth, hook
installation, spooling, or event construction — all of that lives in
`packages/setup-cli` and is tested. If the extension dies, telemetry keeps
flowing (git hooks are machine-global, not editor-bound).

The one place it does more than wrap: **heartbeats** (§4a), which are new
first-party telemetry and the phase's accuracy payoff. Git-only data starts a
session at the first commit and ends it at the last, silently dropping the work
before and after; heartbeats close both gaps for every dev, AI-assisted or not.

## 2. What already exists (build on it, don't rebuild)

- `packages/setup-cli` builds **self-contained CJS bundles** via tsup:
  `dist/cli.js` + `dist/agent.js` (deps inlined, run with bare `node`, CJS on
  purpose). `runInstall/runStatus/runUninstall` live in `src/install.ts`;
  device-auth polling in `src/device-auth.ts`.
- Install = write `~/.devpulse/{agent.js,hooks/,credentials}` + set global
  `core.hooksPath` (chains any pre-existing path). Uninstall reverses it.
- Device flow: `POST /api/auth/device/start` → user opens
  `<APP_URL>/activate`, signs in (Google SSO or dev-login), enters code →
  CLI polls `token` → credentials saved 0600.
- Dashboard (Phase 4) is live: timeline / task detail / team / settings /
  activate. Issue keys come from branch names (`\b[A-Z][A-Z0-9_]+-\d+\b`,
  branch only for now).
- **Gap to know about:** spec §4.7 says the heartbeat endpoint already exists —
  **it does NOT.** Phase 1 only shipped `POST /api/ingest/events`. The
  `heartbeat` event type IS already in the shared zod union and the DB
  `event_type` enum, but no route accepts one. Heartbeats are **core scope**
  for this phase (§3.6), so building that route is part of the work.

## 3. Product scope (MVP — what the demo needs)

1. **First-run setup flow.** On activation, detect state (is
   `~/.devpulse/credentials` present? does `core.hooksPath` point at
   `~/.devpulse/hooks`?). If not set up: show a welcome view / notification
   with **"Enable DevPulse"**. Clicking it runs the equivalent of
   `install --url <configured URL>`, surfaces the user code + "Open activation
   page" button (opens `<url>/activate` in the browser), and shows progress
   until the token lands. Idempotent, like the CLI.
2. **Status bar item.** Shows DevPulse state at a glance:
   - not set up → `$(pulse) DevPulse: Set up` (click → setup flow)
   - active → `$(pulse) <ISSUE-KEY>` derived from the current repo's branch
     (workspace folder's git HEAD), or `DevPulse ✓` when no key. Tooltip:
     dashboard URL, token label, last event sent (read
     `~/.devpulse/last-send.json`, same as CLI `status`).
3. **Commands** (palette, `devpulse.` prefix): Enable/Set up · Status ·
   Open Dashboard · Open Current Task (uses branch issue key →
   `<url>/tasks/<KEY>`) · Uninstall (with confirm dialog).
4. **Settings:** `devpulse.dashboardUrl` (string, default the Vercel URL).
5. **Branch-name nudge (small but demo-gold):** when the current branch has no
   issue key, status bar shows a subtle warning state; tooltip explains
   "name branches like TEX-123-description so time lands on the ticket."
6. **Heartbeats — the accuracy fix (core, see §4a).** Presence pings while the
   dev is actively working, so sessions no longer start at the first commit and
   end at the last one.

**Out of scope (MVP):** task quick-pick that writes `task_start` events (needs
Phase 3 MCP/read scope), drafts notifications (needs Phase 5), webviews,
capturing anything about the editor beyond repo/branch/timestamp.

## 4. Architecture & key decisions

- New workspace package `packages/vscode-extension` (name `devpulse-vscode`,
  `displayName: DevPulse`). Bundle with **esbuild to a single CJS `dist/extension.js`**
  (VS Code extensions are CJS; matches the setup-cli precedent).
- **How to reuse the CLI logic — import, don't shell out to npx:** depend on
  `@devpulse/setup` as a workspace dep and import `runInstall`/`runStatus`/
  `runUninstall` directly; esbuild inlines them. One caveat: `install.ts`
  locates `agent.js` next to `__dirname` — ship `agent.js` inside the
  extension (copy `packages/setup-cli/dist/agent.js` into the extension's
  `dist/` at build time, `agentSourcePath` may need an override parameter —
  small, surgical change to setup-cli is acceptable; keep CLI behavior
  identical).
- Device login must not block the extension host: reuse `deviceLogin` but wire
  its `log` callback into a VS Code progress notification
  (`withProgress`), and open the verification URI via `vscode.env.openExternal`.
- Git facts (current branch) via the built-in `vscode.git` extension API
  (no child_process for watching; it exposes repo state + onDidChange).
  Fall back to `git rev-parse --abbrev-ref HEAD` if the API is unavailable.
- The extension NEVER touches Jira/Tempo creds and never reads code contents.
  The only thing it sends on its own is a heartbeat (§4a), carrying repo
  basename + branch + timestamp — privacy posture unchanged (spec §2). The
  agent token stays in `~/.devpulse/credentials` (0600), written by the reused
  CLI code.
- `engines.vscode` ^1.85 or later; also works in Cursor (test if convenient,
  don't block on it).

## 4a. Heartbeats (core scope — read this carefully)

**Why it matters.** Git-only telemetry measures the time *between* commits, so
it systematically under-counts real work. Concretely, with today's data:

- Dev opens the laptop at 10:00, works, commits once at 10:30. First event of
  the day IS that commit, so the session is 10:30–10:30 = **0 minutes.** Thirty
  minutes of real work are invisible.
- Dev commits at 10:30 and keeps working until 12:00. Session ends at the last
  event, so **90 more minutes vanish.**

Heartbeats fix **both ends** of every session and are **agent-agnostic** — they
benefit the dev who never touches AI, who is currently the worst-served user.
This is the difference between "roughly indicative" and "trustworthy enough to
log to Jira," which is the whole point of the product.

**Server side (build this first — it does not exist):**

- `POST /api/ingest/heartbeat` in `apps/dashboard/src/app/api/ingest/heartbeat`.
- Bearer agent-token auth, reusing `authenticateAgentToken` + the rate limiter
  from the events route. Payload validated by a zod schema that lives ONLY in
  `packages/shared` (CLAUDE.md rule). Carry repo basename + branch + client
  `ts` + `event_uuid`; the `heartbeat` member of the event union already exists,
  so prefer reusing it over inventing a parallel shape.
- Persist as a normal append-only `events` row (`type: "heartbeat"`,
  `source: "extension"`). Issue key derives from the branch exactly as
  `toEventRow` already does — no special-casing in the stitcher.
- Idempotent on `event_uuid` like `/events`. Spec §4.1 calls this endpoint
  "lightweight": keep it a single insert, no batching required.

**Client side (the extension):**

- Ping every **5 minutes** while the dev is *actively working*, not merely while
  the window is open.
- **Idle detection is mandatory.** Gate the ping on real activity — a document
  change / save / editor selection within the last ~5 minutes. A heartbeat that
  fires on window focus alone will log 8 phantom hours when someone leaves VS
  Code open overnight, which would poison the very metric this phase exists to
  fix. Stop pinging when idle; resume on the next real edit.
- Never send file paths, file names, or contents — repo basename and branch
  only (spec §2). Same 2s-timeout, fire-and-forget, never-block-the-editor
  posture as the git hooks.
- Reuse the stored agent token from `~/.devpulse/credentials`; if the user is
  not set up, send nothing (no nagging).

**Stitcher interaction (verify, don't change):** the 45-minute gap rule in
`apps/dashboard/src/lib/stitch.ts` needs no modification — 5-minute pings simply
never trip the gap while work is ongoing, and the last ping becomes the session
end, so the trailing over-count is bounded by the interval (~5 min) instead of
losing hours. Add a stitcher test proving a heartbeat-led session starts at the
first heartbeat, not the first commit.

**Honest limits to note in the phase notes:** covers VS Code / Cursor only
(vim / JetBrains devs get git-only accuracy), and it measures *editor presence* —
not debugging in a browser, meetings, or whiteboarding. It is a good proxy, not
truth.

## 5. Acceptance checks (become tests where feasible)

- Fresh machine (or scratch `HOME`/`DEVPULSE_HOME`/`GIT_CONFIG_GLOBAL`):
  install extension → Enable → approve in browser → status bar goes active;
  `~/.devpulse` contents identical to a CLI install; a commit in any repo
  produces an event attributed to the approving user.
- Status bar shows the issue key on a `TEX-123-*` branch and the nudge state
  on `main`; updates on branch switch without reload.
- Uninstall from the palette restores prior `core.hooksPath` (parity with CLI
  uninstall) and flips the status bar back to "Set up".
- Extension host never blocks >100ms on activation (lazy-init; no sync fs/git
  at startup beyond a stat).
- **Heartbeats:** editing a file produces a `heartbeat` event (source
  `extension`) within ~5 min, carrying repo + branch and nothing else;
  `curl`ing the endpoint without a token returns 401; a duplicate
  `event_uuid` is skipped like `/events`.
- **Idle:** leaving the editor open but untouched for 20 minutes produces NO
  further heartbeats (unit-test the pure idle-decision function; verify once
  by hand with a shortened interval).
- **The accuracy win, end to end:** edit from 10:00, commit at 10:30, stitch →
  the session reads ~30 min starting at 10:00 (not 0 min at 10:30). This is the
  headline check for the phase.
- Unit tests (vitest) for any pure logic added (state detection, issue-key
  from branch reuses `@devpulse/shared`); manual checklist for the UI flows.
- `pnpm --filter devpulse-vscode package` produces an installable `.vsix`.

## 6. Distribution plan (demo now, marketplace later)

1. **Demo / team testing — no marketplace, no approval:** package a `.vsix`
   (`vsce package`) and share the file (Slack/GitHub release). Anyone installs
   via Extensions panel → "Install from VSIX…" or
   `code --install-extension devpulse-0.x.x.vsix`. Works in Cursor too.
2. **Later — VS Code Marketplace:** free Microsoft publisher account (Azure
   DevOps PAT) + `vsce publish`. Automated scan only; typically live in
   minutes, no human review gate. Cursor users primarily pull from Open VSX —
   publish there too (`ovsx publish`) when it matters.
3. Keep the raw CLI path documented for non-VS-Code devs (docs/deployment.md §5).

## 7. Done means

`docs/phase-6-notes.md` written (decisions, gotchas, how to package/sideload,
the heartbeat interval + idle rule as shipped and its honest limits, and a demo
script addition: "install VSIX → Enable → edit + commit → refresh dashboard,
note the session starts when work started, not at the commit"). No Phase 3/5
work started. Update docs/deployment.md §5 to lead with the extension and keep
the two-file CLI as fallback.

**Suggested order:** heartbeat endpoint + shared schema (server, testable on its
own) → extension scaffold + setup flow → status bar → heartbeat sender with idle
detection → packaging. That way the accuracy win is verifiable with `curl`
before any VS Code UI exists.
