# Phase 6 — VS Code extension notes

Scope delivered: `packages/vscode-extension` (`devpulse-vscode`, displayName
**DevPulse**) — one-click setup, a status bar item showing the current branch's
issue key, five palette commands, the branch-name nudge, and a `.vsix` you can
sideload. Plus the surgical `@devpulse/setup` changes that let the extension
*import* the tested CLI logic instead of reimplementing it or shelling out.
All Phase-6 acceptance checks pass. **No Phase 3 (MCP) or Phase 5 (drafts/sync)
work started.** Heartbeats (the optional stretch) were deliberately skipped —
see "Deferred" below.

## Layout (new/changed)

```
packages/setup-cli/
  src/index.ts                  # NEW: public in-process surface (importable)
  package.json                  # + main/types/exports → ./src/index.ts
  src/install.ts                # + InstallOptions.{agentSourcePath,log,onCode,signal}
                                # + UninstallOptions.log, + getStatus() behind runStatus()
  src/device-auth.ts            # + DeviceLoginOptions.{onCode,signal}
  test/device-auth.test.ts      # NEW: onCode/abort/denied/already-claimed (4 tests)

packages/vscode-extension/
  package.json                  # manifest: commands, devpulse.dashboardUrl, scripts
  esbuild.mjs                   # → dist/extension.js (CJS) + copies dist/agent.js
  .vscodeignore .vscode/{launch,tasks}.json README.md
  src/
    extension.ts                # activation, commands, refresh loop
    status-bar.ts               # StatusBarItem adapter
    git-context.ts              # vscode.git API + `git rev-parse` fallback
    setup-flow.ts               # withProgress around runInstall / runUninstall
    lib/                        # PURE, editor-free (unit-tested)
      state.ts                  #   setup-state detection from getStatus()
      presentation.ts           #   status bar text/tooltip/command/warning
      report.ts                 #   plain-text status for the output channel
      urls.ts                   #   dashboard URL normalisation + links
  test/                         # 54 tests (see below)

docs/deployment.md §5           # now leads with the extension; CLI is the fallback
.gitignore                      # *.vsix, packages/vscode-extension/.devpulse-dev/
```

## Key decisions

- **Import the CLI, don't shell out** (brief §4). `@devpulse/setup` gained
  `src/index.ts` plus `main`/`types`/`exports` pointing at **source** — the same
  pattern `@devpulse/shared` already uses, since both are workspace-internal and
  their consumers bundle them. esbuild inlines `runInstall`/`runStatus`-data/
  `runUninstall`/`deviceLogin` (and zod) into `dist/extension.js`. The setup CLI
  still ships as its own two tsup bundles; nothing about its behaviour changed.

- **Four surgical additions to setup-cli**, all additive and all defaulting to
  today's behaviour so `dist/cli.js` output is byte-for-byte the same:
  - `InstallOptions.agentSourcePath` — `install.ts` used to hard-code
    `path.join(__dirname, "agent.js")`. The extension ships its own copy of
    `agent.js` in `dist/` and passes that path. (It would have worked by accident
    — the bundle's `__dirname` *is* that folder — but relying on that is fragile.)
  - `InstallOptions.log` / `UninstallOptions.log` — a `(msg: string) => void`
    sink, defaulting to `console.log`. Multi-argument `console.log(a, b)` calls
    became single template strings, which reproduce console's space-joining
    exactly (verified against a scratch-`HOME` `status` run).
  - `DeviceLoginOptions.onCode` — fires once with the parsed
    `DeviceStartResponse` before polling starts. A GUI needs the code and
    verification URI **as data** to render a button; parsing them back out of log
    lines would be absurd.
  - `DeviceLoginOptions.signal` (threaded from `InstallOptions.signal`) — the
    poll loop checks it either side of each sleep. Without this, dismissing the
    progress notification would leave a loop polling for the code's full 10-min
    lifetime.
  - `getStatus(): DevpulseStatus` — extracted from `runStatus()`, which now just
    prints it. "What is installed" is defined once; the CLI and the extension
    tooltip can't drift.

- **All the interesting logic is in `src/lib/**`, which never imports `vscode`.**
  That is what makes the acceptance checks testable without an Electron host, and
  `test/no-vscode-imports.test.ts` guards the boundary (a stray import would
  silently move rules out of coverage). `extension.ts` / `status-bar.ts` /
  `git-context.ts` / `setup-flow.ts` are the only editor-aware files.

- **Activation does no fs, git or network work at all** — not even a stat. It
  creates the status bar item ("$(pulse) DevPulse"), registers commands and event
  listeners, then `setTimeout(0)` defers everything else. Measured **0.35 ms**
  against the 100 ms budget. The deferred `start()` wires `vscode.git`, runs the
  first state detection, and only then may show the welcome notification.

- **Branch facts come from the built-in `vscode.git` API**, which already watches
  `.git/HEAD` per repository — so branch switches re-render with no polling and no
  file watcher. `GitContext` subscribes to `onDidChangeState`,
  `onDidOpenRepository`, `onDidCloseRepository` and each repo's
  `state.onDidChange`. If the extension is missing or `git.enabled: false`, it
  falls back to one short `git rev-parse` per refresh.
  - The fallback tries `rev-parse --abbrev-ref HEAD` and then
    `symbolic-ref --short HEAD`: the former says `HEAD` when detached and *fails
    outright* on an unborn branch (freshly `git init`ed repo), the latter names
    the branch pre-first-commit and fails when detached. Together they give the
    right answer in all three states.
  - Which repo is "current": the one containing the active editor's document,
    else the first open repository.

- **Status bar states.** The brief is in mild tension between §3.2 ("`DevPulse ✓`
  when no key") and §3.5 ("keyless branch → subtle warning state"); §3.5 is the
  later, more specific refinement, so:

  | Situation | Text | Warning bg | Click |
  |---|---|---|---|
  | state unknown (first ~50 ms) | `$(pulse) DevPulse` | no | Status |
  | not installed | `$(pulse) DevPulse: Set up` | no | Enable |
  | half-installed | `$(pulse) DevPulse: Finish setup` | **yes** | Enable |
  | active, branch has a key | `$(pulse) TEX-123` | no | Open current task |
  | active, branch has no key | `$(pulse) DevPulse: no ticket` | **yes** | Open dashboard |
  | active, no git repo open | `$(pulse) DevPulse ✓` | no | Open dashboard |

  Tooltip always carries the dashboard URL (as a link), token label, last event
  sent (relative time, from `~/.devpulse/last-send.json`) and any offline spool
  count. `DevPulse ✓` explicitly says hooks are machine-global, so an editor
  window without a repo isn't a problem.

- **A third state — `partial` — beyond the brief's two.** The brief asks "creds
  present? hooksPath ours?"; those can disagree (something else grabbed global
  `core.hooksPath`, or an install was interrupted). Rather than lie in either
  direction, `partial` warns and explains *why* in the tooltip, and clicking
  re-runs the idempotent install to repair it.

- **The extension sends nothing and reads no code.** It never constructs an
  event, never talks to the ingestion API, and never holds Jira/Tempo creds. The
  agent token is written to `~/.devpulse/credentials` (0600) by the reused CLI
  code and is never rendered — asserted by tests on both the tooltip and the
  output-channel report. Only the repo *basename* and branch name are surfaced.

- **Welcome notification, not a webview.** Shown once per machine when not
  active; "Don't ask again" persists in `globalState`. Webviews were explicitly
  out of scope.

- **A 60 s refresh tick, gated on `window.state.focused`**, keeps the tooltip's
  "last event sent" honest after a commit without any user action. Refreshes are
  coalesced (150 ms) and re-entrancy-guarded, so a burst of git events costs one
  pass.

## Gotchas

- **`getStatus()` runs one `git config --global` subprocess** (~10 ms) plus a few
  sync fs reads. Fine, but it must stay off the activation path — that's why
  `start()` is deferred. If you add another caller, don't call it synchronously
  from an event handler that fires often.
- **husky still wins.** husky sets `core.hooksPath` at *repo* scope, which
  overrides our *global* one, so in a husky repo our hooks don't fire (documented
  in phase-2-notes). The extension can't detect that today: it reports `active`
  because the machine-level install *is* correct. Per-repo detection is a future
  option.
- **`@types/vscode` must be pinned to the `engines.vscode` floor** (`1.85.0`
  exactly, not `^1.85.0`). With a caret, pnpm resolves the latest types and
  `vsce package` refuses: types newer than the declared engine.
- **`vsce package` tolerates `"private": true`** (only `publish` cares), so the
  manifest keeps it — the package must never reach npm.
- **`vsce` warns "LICENSE not found"** and packages anyway. The repo has no
  LICENSE file; add one if you ever publish to a marketplace.
- **`.vscodeignore` needs `.turbo/**`** or turbo's task logs end up inside the
  VSIX (they did, on the first run).
- **Bundling loses `require.cache` tricks.** In `test/activation.test.ts` each
  test copies the bundle to a fresh filename to get a module instance bound to
  its own fake `vscode`; deleting from `require.cache` is unreliable under
  vitest's module runner.
- The extension bundle's only external requires are `vscode` and node builtins
  (`node:fs`, `node:os`, `node:path`, `node:child_process`) — worth re-checking
  if you add a dependency.

## Tests — 54 in this package, 140 across the repo

`pnpm test` → 21 shared · 37 dashboard · **28** setup-cli (+4) · **54**
vscode-extension.

Pure logic (`test/{state,presentation,report,urls,no-vscode-imports}.test.ts`,
42 tests): setup-state detection and its `partial` explanations; every status bar
state including the issue key on a `TEX-123-*` branch and the nudge on `main`;
issue-key extraction proven identical to `@devpulse/shared`'s `extractIssueKey`
(the regex is never re-declared); relative-time and last-send formatting; URL
normalisation; and the editor-free guard on `src/lib`.

Integration (`test/activation.test.ts`, 12 tests, with `test/fake-vscode.ts`):
bundles the real `src/extension.ts` with esbuild, loads it against a stub
`vscode` module, and drives `activate()` — activation latency, command
registration, the fresh-machine → "Set up" transition, welcome/dismissal,
`openDashboard`/`openCurrentTask`, disposal, and (with a real install into a
scratch `DEVPULSE_HOME` and a real scratch git repo) the active states, branch
switching through the CLI fallback, the output-channel report, and uninstall
restoring a pre-existing `core.hooksPath`. `DEVPULSE_HOME` and
`GIT_CONFIG_GLOBAL` are always scratch paths — the suite never reads or writes a
real DevPulse install or global git config.

## Acceptance — verified

- **`~/.devpulse` contents identical to a CLI install.** `runInstall` was run
  twice into scratch homes — once via `dist/cli.js`, once via the extension's
  import path with `agentSourcePath` pointing at the extension's `dist/agent.js`
  — and the trees diffed **byte-identical** (same 7 entries, `agent.js` 0755,
  `credentials` 0600, hooks 0755, identical hook scripts modulo the home path)
  with identical `core.hooksPath` in the scratch git configs.
- **Chaining + uninstall parity through the extension's code path**: installing
  over a pre-existing global `hooksPath` stored and chained it; uninstall
  restored it exactly. Also covered as a test.
- **Status bar shows the issue key on `TEX-123-*` and the nudge on `main`, and
  updates on branch switch without reload** — integration-tested against a real
  scratch repo; live, the `vscode.git` `state.onDidChange` event drives it.
- **Activation never blocks >100 ms**: measured **0.35 ms**, with an assertion at
  the 100 ms threshold and a check that `~/.devpulse` is untouched at that point.
- **`pnpm --filter devpulse-vscode package` produces an installable `.vsix`** —
  `devpulse-vscode-0.1.0.vsix`, 6 files, ~50 KB (manifest, readme,
  `dist/extension.js`, `dist/agent.js`).
- **Device flow additions** (`onCode` fires before polling; abort stops the loop;
  denied / already-claimed surface as errors) — 4 new setup-cli tests.
- `pnpm typecheck` clean across all 6 packages; `pnpm test` green.

**Not machine-verified here** (needs a real editor + the deployed dashboard, so
it's the manual checklist): the browser hand-off itself — clicking "Open
activation page", signing in, and watching the status bar flip to the issue key.
The device handshake either side of that is covered by tests, and the resulting
machine state is proven identical to the CLI's.

## Package / sideload / demo

```bash
# build + package
pnpm install
pnpm --filter devpulse-vscode package     # → packages/vscode-extension/devpulse-vscode-0.1.0.vsix

# install for yourself or a teammate (works in Cursor too)
code --install-extension packages/vscode-extension/devpulse-vscode-0.1.0.vsix
# or: Extensions panel → ··· → "Install from VSIX…"
```

Share the `.vsix` over Slack or a GitHub release — no marketplace, no approval
(brief §7). For the marketplace later: create a Microsoft publisher, replace the
placeholder `publisher: "devpulse"` with the real id, add a LICENSE, then
`vsce publish`; Cursor users pull from Open VSX, so `ovsx publish` too.

### Demo script addition

Append to the Phase-4 demo (docs/phase-4-notes.md) — the onboarding story:

```
1. "Onboarding used to be two files and a terminal command." → install the VSIX
   (Extensions → Install from VSIX…). Reload.
2. Notification: "Enable DevPulse to track task time automatically?" → click
   Enable DevPulse.
3. Progress notification shows the code (already on the clipboard) → click
   "Open activation page" → sign in → paste the code → Approve.
4. Status bar flips to the current branch's ticket, e.g. `$(pulse) TEX-123`.
   Hover: dashboard URL, token label, "Last event sent: none yet".
5. Commit anything in any repo. Hover again → "Last event sent: just now".
6. Click the status bar item → the dashboard opens straight to that task.
7. `git checkout main` → status bar becomes "DevPulse: no ticket" with the
   branch-naming nudge. Switch back → the ticket returns, no reload.
```

## Deferred

- **Heartbeats (brief §5, optional stretch) — skipped.** `POST
  /api/ingest/heartbeat` still does not exist (spec §4.7 claims otherwise; only
  `POST /api/ingest/events` shipped in Phase 1). Adding it means a new route + a
  shared zod schema + the extension sending on a timer, i.e. touching ingestion
  for a stitching refinement that nothing currently needs. The `heartbeat` event
  type is already in the shared enum, so it slots in later; do it in the phase
  that actually needs tighter stitching between commits.
- **Task quick-pick writing `task_start` events** — needs Phase 3 (MCP) and the
  own-data read scope. **Drafts-ready notifications** — needs Phase 5. Both
  explicitly out of MVP scope here.
- **Per-repo `core.hooksPath` detection** (the husky case above).
- **Cursor** was not tested (the brief said don't block on it). It loads CJS
  extensions the same way and the manifest uses no VS Code-only contribution
  points, so it should work; verify before relying on it.
