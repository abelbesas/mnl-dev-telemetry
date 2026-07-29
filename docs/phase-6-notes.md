# Phase 6 — VS Code extension notes

Scope delivered, in two parts:

1. **Setup + visibility** — `packages/vscode-extension` (`mnl-dev-telemetry-vscode`,
   displayName **MnlDevTelemetry**): one-click setup, a status bar item showing the
   current branch's issue key, five palette commands, the branch-name nudge, and
   a sideloadable `.vsix`. Plus the surgical `@mnl-dev-telemetry/setup` changes that let
   the extension *import* the tested CLI logic instead of reimplementing it.
2. **Heartbeats (§4a) — the accuracy payoff** — the `POST
   /api/ingest/heartbeat` route that spec §4.7 claimed existed but never did,
   its shared zod schema, and an idle-gated sender in the extension. This is
   what stops a session from starting at the first commit and ending at the
   last.

All Phase-6 acceptance checks pass, including the headline one. **No Phase 3
(MCP) or Phase 5 (drafts/sync) work started.**

## Layout (new/changed)

```
packages/shared/
  src/events.ts                 # + heartbeatRequestSchema/ResponseSchema (heartbeatEvent exported)
  src/config.ts                 # + HEARTBEAT_INTERVAL_MINUTES / HEARTBEAT_IDLE_MINUTES
  src/client.ts                 # + IngestClient.sendHeartbeat (post() extracted)
  test/heartbeat.test.ts        # NEW: contract + privacy stripping (10 tests)

apps/dashboard/
  src/app/api/ingest/heartbeat/route.ts   # NEW: the missing endpoint
  test/heartbeat-stitch.test.ts # NEW: the accuracy win vs the unchanged stitcher (8 tests)
  test/ingest.test.ts           # + heartbeat → toEventRow (4 tests)

packages/setup-cli/
  src/index.ts                  # NEW: public in-process surface (importable)
  package.json                  # + main/types/exports → ./src/index.ts
  src/install.ts                # + InstallOptions.{agentSourcePath,log,onCode,signal}
                                # + UninstallOptions.log, + getStatus() behind runStatus()
  src/device-auth.ts            # + DeviceLoginOptions.{onCode,signal}
  test/device-auth.test.ts      # NEW: onCode/abort/denied/already-claimed (4 tests)

packages/vscode-extension/
  package.json                  # manifest: commands, mnlDevTelemetry.dashboardUrl, scripts
  esbuild.mjs                   # → dist/extension.js (CJS) + copies dist/agent.js
  .vscodeignore .vscode/{launch,tasks}.json README.md
  src/
    extension.ts                # activation, commands, refresh loop
    status-bar.ts               # StatusBarItem adapter
    git-context.ts              # vscode.git API + `git rev-parse` fallback
    setup-flow.ts               # withProgress around runInstall / runUninstall
    heartbeat.ts                # NEW: activity stamping + the 5-min sender
    lib/                        # PURE, editor-free (unit-tested)
      state.ts                  #   setup-state detection from getStatus()
      presentation.ts           #   status bar text/tooltip/command/warning
      report.ts                 #   plain-text status for the output channel
      urls.ts                   #   dashboard URL normalisation + links
      heartbeat.ts              #   NEW: shouldSendHeartbeat (the idle rule)
  test/                         # 84 tests (see below)

docs/deployment.md §5           # now leads with the extension; CLI is the fallback
.gitignore                      # *.vsix, packages/vscode-extension/.devpulse-dev/
```

## Key decisions

- **Import the CLI, don't shell out** (brief §4). `@mnl-dev-telemetry/setup` gained
  `src/index.ts` plus `main`/`types`/`exports` pointing at **source** — the same
  pattern `@mnl-dev-telemetry/shared` already uses, since both are workspace-internal and
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
  - `getStatus(): MnlDevTelemetryStatus` — extracted from `runStatus()`, which now just
    prints it. "What is installed" is defined once; the CLI and the extension
    tooltip can't drift.

- **All the interesting logic is in `src/lib/**`, which never imports `vscode`.**
  That is what makes the acceptance checks testable without an Electron host, and
  `test/no-vscode-imports.test.ts` guards the boundary (a stray import would
  silently move rules out of coverage). `extension.ts` / `status-bar.ts` /
  `git-context.ts` / `setup-flow.ts` are the only editor-aware files.

- **Activation does no fs, git or network work at all** — not even a stat. It
  creates the status bar item ("$(pulse) MnlDevTelemetry"), registers commands and event
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

- **Status bar states.** The brief is in mild tension between §3.2 ("`MnlDevTelemetry ✓`
  when no key") and §3.5 ("keyless branch → subtle warning state"); §3.5 is the
  later, more specific refinement, so:

  | Situation | Text | Warning bg | Click |
  |---|---|---|---|
  | state unknown (first ~50 ms) | `$(pulse) MnlDevTelemetry` | no | Status |
  | not installed | `$(pulse) MnlDevTelemetry: Set up` | no | Enable |
  | half-installed | `$(pulse) MnlDevTelemetry: Finish setup` | **yes** | Enable |
  | active, branch has a key | `$(pulse) TEX-123` | no | Open current task |
  | active, branch has no key | `$(pulse) MnlDevTelemetry: no ticket` | **yes** | Open dashboard |
  | active, no git repo open | `$(pulse) MnlDevTelemetry ✓` | no | Open dashboard |

  Tooltip always carries the dashboard URL (as a link), token label, last event
  sent (relative time, from `~/.devpulse/last-send.json`) and any offline spool
  count. `MnlDevTelemetry ✓` explicitly says hooks are machine-global, so an editor
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

## Heartbeats as shipped (§4a)

**The problem, in one table.** Same 30 minutes of work, measured both ways —
this is real output from the local stack, not an illustration:

| issue_key | started | ended | events | reported |
|---|---|---|---|---|
| TEX-777 (heartbeats + commit) | 10:00 | 10:30 | 8 | **30 min** |
| TEX-778 (commit only) | 10:30 | 10:30 | 1 | **0 min** |

**Server.** `POST /api/ingest/heartbeat` reuses `parseBearerToken` →
`authenticateAgentToken` → `RateLimiter` → `toEventRow` from the events route, so
auth, rate limiting, issue-key derivation and idempotency behave identically. It
inserts exactly one append-only `events` row (`type: "heartbeat"`,
`source: "extension"`) with `onConflictDoNothing` on `event_uuid`, and returns
`{inserted, skipped}` where each is 0 or 1. No batching — spec §4.1 calls this
endpoint "lightweight" and a single insert is the whole job.

**Schema.** `heartbeatRequestSchema` is the *existing* `heartbeat` member of the
event union with `source` and `type` given defaults. That was a deliberate
choice over a parallel shape: a caller sends only
`{event_uuid, ts, repo, branch}`, and the parsed result is a valid `IngestEvent`
that drops straight into `toEventRow` — which is why **the stitcher needed no
change at all**. A test asserts `eventSchema.safeParse(parsedHeartbeat)` still
passes, so the two can't drift.

**Cadence and the idle rule.** `HEARTBEAT_INTERVAL_MINUTES = 5` and
`HEARTBEAT_IDLE_MINUTES = 5` live in `packages/shared/src/config.ts` next to
`STITCH_GAP_MINUTES = 45`, because the relationship between them is the point:
pings are 9× more frequent than the gap, so they bracket a session instead of
splitting it. `lib/heartbeat.ts` throws at module load if that inverts.

The gate is **real edit activity, never window presence** — the failure the brief
calls out is an editor left open overnight logging 8 phantom hours. The sender
stamps a timestamp (and nothing else) on `onDidChangeTextDocument`,
`onDidSaveTextDocument` and `onDidChangeTextEditorSelection`, then
`shouldSendHeartbeat` refuses to ping when: not set up, no git repo, no activity
yet, >5 min since the last activity, or <5 min since the last ping. It resumes on
the next real edit with no restart.

- **Activity counts only for `scheme === "file"`.** This isn't hygiene, it's a
  real feedback loop that would otherwise exist: our own output channel is a
  document (`scheme: "output"`), so `channel.appendLine` from a heartbeat log
  would register as activity and keep the sender alive forever. `git` diffs,
  `vscode-userdata` settings writes and debug consoles are excluded for the same
  reason. Tested explicitly.
- **`lastSentAt` is stamped before the request, not after.** A slow or failing
  send therefore costs one missed ping rather than producing a retry burst — a
  missed ping is cheaper than a double-counted one. Tested.
- **No spool behind heartbeats**, unlike the git hooks. A dropped ping is
  genuinely fine: the next one is 5 minutes away, and the cost is 5 minutes of
  precision, not a lost event. Failures log to the MnlDevTelemetry output channel and
  are never surfaced to the dev.
- **Heartbeats stop the moment the machine isn't `active`** — uninstall or a
  half-install silences them on the next refresh, asserted in the integration
  tests.

**Privacy (spec §2).** A heartbeat carries repo basename, branch, timestamp and
an idempotency UUID. That's the entire payload, and it's enforced at three
layers: the sender only ever builds those fields, the zod object strips unknown
keys, and the route stores `metadata: {}`. Verified at the DB level by POSTing a
payload with `file`, `content` and `metadata.file_path` set — all three were
stripped and the stored metadata was `{}`. The tooltip and the status report both
disclose the cadence, so a dev can see what the extension sends without reading
the source.

**Honest limits** (the brief asks these be written down):

- **VS Code / Cursor only.** vim, JetBrains and Zed devs still get git-only
  accuracy. The endpoint is editor-agnostic, so any client can adopt it.
- **It measures editor presence, not work.** Debugging in a browser, a meeting
  about the ticket, whiteboarding, or reading code in another window all look
  idle. It's a good proxy, not truth.
- **Trailing over-count of up to one interval.** If the dev stops right after a
  ping, the session runs ~5 minutes long. That's the deliberate trade: bounded
  over-count instead of unbounded loss.
- **A long think with no keystrokes reads as idle.** Selection changes count as
  activity, which softens this, but a genuinely motionless 10 minutes of reading
  will break a session in two. The 45-minute gap means it usually still merges.

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
  (`node:fs`, `node:os`, `node:path`, `node:child_process`, `node:crypto`) —
  worth re-checking if you add a dependency.
- **Never run `pnpm build` (root) while the dashboard dev server is running.**
  `next build` writes into the same `.next/` the dev server is serving from, and
  the dev server then 500s with `Cannot find module './635.js'`. It looks like a
  broken route; it isn't. `rm -rf apps/dashboard/.next` and restart. This cost
  one confusing 500 during heartbeat verification.

## Tests — 84 in this package, 192 across the repo

`pnpm test` → **31** shared (+10) · **49** dashboard (+12) · **28** setup-cli
(+4) · **84** vscode-extension (+30).

Pure logic (`test/{state,presentation,report,urls,heartbeat,no-vscode-imports}.test.ts`,
59 tests): setup-state detection and its `partial` explanations; every status bar
state including the issue key on a `TEX-123-*` branch and the nudge on `main`;
issue-key extraction proven identical to `@mnl-dev-telemetry/shared`'s `extractIssueKey`
(the regex is never re-declared); relative-time and last-send formatting; URL
normalisation; the whole idle rule including the literal "20 minutes untouched"
acceptance check and the activity-scheme filter; and the editor-free guard on
`src/lib`.

Integration (`test/activation.test.ts` 14 tests + `test/heartbeat-sender.test.ts`
11 tests, with `test/fake-vscode.ts`): bundles the real `src/extension.ts` /
`src/heartbeat.ts` with esbuild, loads them against a stub `vscode` module, and
drives them. Covers activation latency, command registration, the fresh-machine
→ "Set up" transition, welcome/dismissal, `openDashboard`/`openCurrentTask`,
disposal, and — with a real install into a scratch `DEVPULSE_HOME` and a real
scratch git repo — the active states, branch switching through the CLI fallback,
the output-channel report, uninstall restoring a pre-existing `core.hooksPath`,
and heartbeats starting/stopping with state. The sender tests drive real document
events through the real subscriptions with `fetch` stubbed: payload shape,
idle-out and resume, interval pacing, non-file schemes ignored, no-credentials
and no-repo silence, and swallowed send failures. `DEVPULSE_HOME` and
`GIT_CONFIG_GLOBAL` are always scratch paths — the suite never reads or writes a
real MnlDevTelemetry install or global git config.

Server-side (`apps/dashboard/test/heartbeat-stitch.test.ts` 8 tests +
`test/ingest.test.ts` +4, `packages/shared/test/heartbeat.test.ts` 10 tests): the
accuracy win against the unchanged stitcher, the gap rule still splitting a real
break, heartbeats never implying AI assistance, the request/response contract,
privacy stripping, and `IngestClient.sendHeartbeat`'s URL and headers.

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
- **`pnpm --filter mnl-dev-telemetry-vscode package` produces an installable `.vsix`** —
  `mnl-dev-telemetry-vscode-0.2.0.vsix`, 6 files, ~52 KB (manifest, readme,
  `dist/extension.js`, `dist/agent.js`).
- **Device flow additions** (`onCode` fires before polling; abort stops the loop;
  denied / already-claimed surface as errors) — 4 new setup-cli tests.
- **The heartbeat endpoint, live against local Postgres** (`curl`, before any UI
  existed, per the brief's suggested order): no token → **401**; bad token →
  **401**; minimal body → **200 `{inserted:1,skipped:0}`** with `source`
  defaulted to `extension`; same `event_uuid` again → **200
  `{inserted:0,skipped:1}`**; non-uuid key → **400** with zod issues. The stored
  row had `type=heartbeat source=extension repo=acme-web
  branch=TEX-123-widget issue_key=TEX-123 metadata={}`.
- **Privacy, at the DB level**: a POST carrying `file`, `content` and
  `metadata.file_path` was accepted, and all three were stripped — stored
  `metadata` was `{}` and no path or content reached the row.
- **The accuracy win, end to end** (the headline check): 7 pings from 10:00 local
  plus a commit at 10:30 stitched to **one session, 10:00→10:30, 8 events,
  30 minutes reported**. The same commit alone stitched to **10:30→10:30,
  0 minutes**. Both numbers came out of the real stitcher against the real DB,
  and are also encoded as tests.
- **The real sender against the real route and DB** (only `vscode` stubbed): no
  activity → nothing sent; one file edit → exactly one row with the issue key
  derived from the branch and `metadata={}`; an immediate second tick → paced, no
  duplicate row.
- `pnpm typecheck` clean across all 6 packages; `pnpm test` green (192 tests).

**Not machine-verified here** (needs a real editor + the deployed dashboard, so
it's the manual checklist): the browser hand-off itself — clicking "Open
activation page", signing in, and watching the status bar flip to the issue key.
The device handshake either side of that is covered by tests, and the resulting
machine state is proven identical to the CLI's.

## Package / sideload / demo

```bash
# build + package
pnpm install
pnpm --filter mnl-dev-telemetry-vscode package     # → packages/vscode-extension/mnl-dev-telemetry-vscode-0.2.0.vsix

# install for yourself or a teammate (works in Cursor too)
code --install-extension packages/vscode-extension/mnl-dev-telemetry-vscode-0.2.0.vsix
# or: Extensions panel → ··· → "Install from VSIX…"
```

Share the `.vsix` over Slack or a GitHub release — no marketplace, no approval
(brief §7). For the marketplace later: create a Microsoft publisher, replace the
placeholder `publisher: "mnl-dev-telemetry"` with the real id, add a LICENSE, then
`vsce publish`; Cursor users pull from Open VSX, so `ovsx publish` too.

### Demo script addition

Append to the Phase-4 demo (docs/phase-4-notes.md) — the onboarding story:

```
1. "Onboarding used to be two files and a terminal command." → install the VSIX
   (Extensions → Install from VSIX…). Reload.
2. Notification: "Enable MnlDevTelemetry to track task time automatically?" → click
   Enable MnlDevTelemetry.
3. Progress notification shows the code (already on the clipboard) → click
   "Open activation page" → sign in → paste the code → Approve.
4. Status bar flips to the current branch's ticket, e.g. `$(pulse) TEX-123`.
   Hover: dashboard URL, token label, "Last event sent: none yet", and
   "Heartbeat: every 5 min while you're editing — repo + branch only".
5. Commit anything in any repo. Hover again → "Last event sent: just now".
6. Click the status bar item → the dashboard opens straight to that task.
7. `git checkout main` → status bar becomes "MnlDevTelemetry: no ticket" with the
   branch-naming nudge. Switch back → the ticket returns, no reload.
```

Then the accuracy payoff — the part that makes the numbers trustworthy:

```
8. "Here's what git-only telemetry gets you." Show a task whose session starts at
   the commit: 0 minutes for real work.
9. Edit a file in a TEX-123 branch, wait for one ping (or set the interval short
   for the demo), keep editing ~10 minutes, then commit once.
10. Refresh the dashboard timeline → the session starts when you STARTED WORKING,
    not at the commit, and keeps counting past it. Same commit, honest duration.
11. Walk away for 20 minutes without touching the editor → no further pings, so
    the session closes instead of billing your lunch. `MnlDevTelemetry: Show status`
    shows "heartbeat: on — every 5 min while editing, stops after 5 min idle".
12. The point to land: this works for the dev who never touches AI. It is the
    difference between "roughly indicative" and "good enough to log to Jira".
```

## Deferred

- **Task quick-pick writing `task_start` events** — needs Phase 3 (MCP) and the
  own-data read scope. **Drafts-ready notifications** — needs Phase 5. Both
  explicitly out of MVP scope here.
- **Per-repo `core.hooksPath` detection** (the husky case above).
- **Cursor** was not tested (the brief said don't block on it). It loads CJS
  extensions the same way and the manifest uses no VS Code-only contribution
  points, so it should work; verify before relying on it.
- **Heartbeats from other editors.** The endpoint is editor-agnostic and takes
  four fields, so a vim/JetBrains plugin (or even a shell loop) can adopt it
  without server changes. Only the VS Code sender shipped here.
- **A user-facing interval / opt-out setting.** The cadence is a shared constant,
  not a `mnlDevTelemetry.*` setting, so a dev can't currently turn heartbeats off
  independently of MnlDevTelemetry itself. Add one if anyone objects to being pinged —
  the honest answer today is "uninstall or run the uninstall command".
