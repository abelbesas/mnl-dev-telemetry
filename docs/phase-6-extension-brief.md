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

The extension is deliberately a **thin UI wrapper around the existing setup
CLI**. It must not reimplement device-auth, hook installation, spooling, or
event construction — all of that lives in `packages/setup-cli` and is tested.
If the extension dies, telemetry keeps flowing (git hooks are machine-global,
not editor-bound). The extension only makes setup/visibility nicer.

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
- **Gap to know about:** spec §4.7 says the heartbeat endpoint exists —
  it does NOT. Phase 1 only shipped `POST /api/ingest/events`. Heartbeats are
  therefore OPTIONAL scope here (see §5); if included, add the route + shared
  zod schema server-side too (schemas ONLY in `packages/shared`).

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

**Out of scope (MVP):** task quick-pick that writes `task_start` events (needs
Phase 3 MCP/read scope), drafts notifications (needs Phase 5), webviews,
telemetry of the editor itself. Heartbeats optional-stretch only.

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
- The extension NEVER touches Jira/Tempo creds, never reads code contents,
  and never sends anything itself in MVP scope — privacy posture unchanged
  (spec §2). The agent token stays in `~/.devpulse/credentials` (0600),
  written by the reused CLI code.
- `engines.vscode` ^1.85 or later; also works in Cursor (test if convenient,
  don't block on it).

## 5. Optional stretch (only if MVP lands early)

Heartbeats: `POST /api/ingest/heartbeat` route (bearer agent token, zod schema
in `packages/shared`, append-only event type `heartbeat` already exists in the
schema/enum) + extension sends one every ~5 min while the window is focused,
carrying repo basename + branch only. This sharpens stitching between commits.
If skipped, note it for a later phase.

## 6. Acceptance checks (become tests where feasible)

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
- Unit tests (vitest) for any pure logic added (state detection, issue-key
  from branch reuses `@devpulse/shared`); manual checklist for the UI flows.
- `pnpm --filter devpulse-vscode package` produces an installable `.vsix`.

## 7. Distribution plan (demo now, marketplace later)

1. **Demo / team testing — no marketplace, no approval:** package a `.vsix`
   (`vsce package`) and share the file (Slack/GitHub release). Anyone installs
   via Extensions panel → "Install from VSIX…" or
   `code --install-extension devpulse-0.x.x.vsix`. Works in Cursor too.
2. **Later — VS Code Marketplace:** free Microsoft publisher account (Azure
   DevOps PAT) + `vsce publish`. Automated scan only; typically live in
   minutes, no human review gate. Cursor users primarily pull from Open VSX —
   publish there too (`ovsx publish`) when it matters.
3. Keep the raw CLI path documented for non-VS-Code devs (docs/deployment.md §5).

## 8. Done means

`docs/phase-6-notes.md` written (decisions, gotchas, how to package/sideload,
demo script addition: "install VSIX → Enable → commit → refresh dashboard").
No Phase 3/5 work started. Update docs/deployment.md §5 to lead with the
extension and keep the two-file CLI as fallback.
