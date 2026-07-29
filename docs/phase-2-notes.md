# Phase 2 — Setup CLI + git hooks notes

Scope delivered: `packages/setup-cli` (`@mnl-dev-telemetry/setup`) — device-auth login,
git-hook installation via global `core.hooksPath` with chaining, a bundled
fire-and-forget agent with offline spool/retry, and `install` / `login` /
`status` / `uninstall` commands. Plus the minimal dashboard device-auth API
routes and their shared zod contract. All acceptance checks verified end-to-end
against local Postgres + the dev server. No Phase 3+ work started.

## Layout

```
packages/shared/src/device-auth.ts        # device-flow zod contract (single source)
apps/dashboard/src/lib/device-codes.ts     # code generation + TTL/interval
apps/dashboard/src/app/api/auth/device/
  start/route.ts  token/route.ts  approve/route.ts
apps/dashboard/src/db/schema.ts            # + device_authorizations table
apps/dashboard/drizzle/0001_*.sql          # additive migration
packages/setup-cli/
  src/cli.ts          # arg parsing → install/login/status/uninstall
  src/install.ts      # orchestration (creds → agent+hooks → hooksPath)
  src/device-auth.ts  # CLI side of the device flow (start → poll)
  src/agent.ts        # ~/.devpulse/agent.js entry (the git-hook worker)
  src/git.ts          # best-effort git fact collection
  src/event.ts        # PURE event construction (tested)
  src/spool.ts        # PURE flushSpool + fs helpers (tested)
  src/hooks-path.ts   # PURE install/uninstall/chain planning (tested)
  src/hook-scripts.ts # POSIX shell hook templates
  src/hooks.ts / git-config.ts / credentials.ts / paths.ts
  test/{spool,hooks-path,event}.test.ts    # 24 tests
```

## Key decisions

- **Two bundled CJS entrypoints via tsup** (`cli.js`, `agent.js`), with
  `@mnl-dev-telemetry/shared` + `zod` inlined (`noExternal`). This is the "plain-node
  consumer" Phase 1 anticipated: the agent runs on a dev's machine with no
  `node_modules`, yet still builds events with the *canonical* shared schemas
  (CLAUDE.md rule — schemas are never redefined). `install` copies the sibling
  `dist/agent.js` to `~/.devpulse/agent.js`.
  - Package has **no `"type": "module"`** so `.js` output is CJS (needed for the
    bare `node agent.js` invocation and `__dirname`).
  - Root `package.json` gained `pnpm.onlyBuiltDependencies: ["esbuild"]` so
    tsup's esbuild binary builds on a fresh clone.

- **Hooks never block or break git** (spec §4.3, verified: an offline commit
  returned in **30 ms**). The shell hook backgrounds the node agent fully
  detached (`</dev/null >/dev/null 2>&1 &`); the agent additionally caps its own
  network call at 2 s (`IngestClient timeoutMs`). Every agent code path — no
  creds, git error, thrown exception — still `exit(0)`.

- **Offline spool + retry** is a pure function (`flushSpool`): it sends
  `pending + fresh` as one batch, clears the spool on success, or re-persists
  (most-recent-first, capped) on failure. Idempotency is free — every event
  carries a client `event_uuid`, so re-sending a batch that partially landed
  returns `skipped`. `SPOOL_CAP = 400`, deliberately `< MAX_EVENTS_PER_BATCH`
  (500) so `pending + one fresh` never exceeds a single batch (there's a runtime
  assertion guarding this).

- **`core.hooksPath` chaining** (spec §4.3 edge case) is split into pure
  planning (`hooks-path.ts`) + shell execution. On install we store the
  pre-existing global value in `~/.devpulse/previous-hooks-path`; each hook,
  after firing our agent, execs `$PREV/<hook>` (if present + executable) and
  **propagates its exit code**, so a dev's existing gate (husky, custom) is
  never swallowed. `pre-push` captures stdin to a temp file and feeds it to the
  chained hook (git delivers ref updates there); our agent reads `</dev/null`.
  - **Idempotent install**: if `core.hooksPath` already points at us, we do NOT
    rewrite `previous-hooks-path` — otherwise a second install would make us
    chain to ourselves. Covered by a unit test and verified live.
  - **Uninstall** only touches `core.hooksPath` if it still points at us, then
    restores the stored previous value (or unsets). Removes hooks, agent, spool,
    credentials, and the home dir if empty.

- **Device-auth flow** (spec §4.3 item 1): `start` mints a `device_code` +
  human `user_code`; the CLI polls `token` until a human hits `approve`, which
  upserts the user, mints the agent token (sha256-hashed into `agent_tokens`,
  audit-logged), and parks the **one-time plaintext** in
  `device_authorizations.token_plaintext`. The first successful poll returns it
  and immediately nulls it (second poll → `already_claimed`). Codes expire after
  10 min (lazily, on read).
  - New **`device_authorizations`** table added via additive migration `0001`
    (the §3 model didn't include it; it reshapes nothing in the Phase-1 tables).
  - Request/response shapes live only in `packages/shared/src/device-auth.ts`.

- **Credentials** at `~/.devpulse/credentials`, JSON `{token, baseUrl, label,
  issuedAt}`, written mode **0600** (verified `-rw-------`). Tiny on purpose —
  it's on the agent hot path.

- **Privacy holds end-to-end** (spec §2): the only metadata keys that reached
  the DB were `sha, files_changed, insertions, deletions, from_branch,
  to_branch, remote, commit_count`. `repo` is the toplevel **basename** only.
  Commit messages are read solely to detect an AI `Co-authored-by:` trailer and
  are never sent/stored. The shared schemas strip anything else.

## Gotchas

- **Fire-and-forget causes a small read race.** Because the agent is
  backgrounded, `git rev-parse --abbrev-ref HEAD` / `@{-1}` run slightly later
  than the git action. When several git commands run back-to-back (as in a test
  script), a `commit`/`branch_switch` event can reflect a *subsequent* HEAD's
  branch. Harmless in interactive use (there's a human gap), and the stitcher
  groups by issue_key/repo anyway — but don't be surprised if a scripted burst
  shows the "wrong" branch. Not worth blocking git to fix.
- **husky sets `core.hooksPath` at *repo* (local) scope**, which overrides our
  *global* one — so in a husky repo our hooks simply don't run (we don't break
  husky either). Our chaining targets a pre-existing *global* hooksPath. This is
  acceptable for the MVP; a future option is per-repo detection.
- `git config --global --unset` exits 5 when the key is missing; `git-config.ts`
  swallows non-zero status so this is a no-op, not an error.
- macOS `date` has no `%N`; irrelevant to the code, only to ad-hoc timing in
  shell during acceptance.

## Run it

```bash
pnpm --filter @mnl-dev-telemetry/setup build     # produces dist/cli.js + dist/agent.js
pnpm test                                # 55 tests (21 shared, 10 dashboard, 24 setup-cli)

# On a dev machine (dashboard running):
node packages/setup-cli/dist/cli.js install --url http://localhost:3000
# → prints a user_code; approve it (until the Phase-4 UI exists):
curl -sX POST http://localhost:3000/api/auth/device/approve \
  -H 'content-type: application/json' \
  -d '{"user_code":"XXXX-XXXX","email":"you@company.com"}'
node packages/setup-cli/dist/cli.js status
node packages/setup-cli/dist/cli.js --uninstall
```

Tip for isolated testing: set `HOME`, `GIT_CONFIG_GLOBAL`, and `DEVPULSE_HOME`
to scratch paths so install never touches your real global git config.

## Acceptance — verified

- Scratch repo: `commit` / `branch_switch` / `push` events all landed in the DB
  with correct metadata + derived issue key.
- **API down**: commit succeeded in ~30 ms and spooled; two offline events then
  drained on the next online commit (`attempted:3, ok:true, spooled:0`).
- **Uninstall** restored the prior `core.hooksPath` (and unset it when there was
  none); full local cleanup.
- **Chaining**: install over a pre-existing global hooksPath ran both our agent
  and the pre-existing `post-commit`; re-install was idempotent (stored previous
  path unchanged); uninstall restored it.
- Credentials file is mode 0600. Device-auth login works end-to-end via the CLI.
- 24 new vitest tests (spool/retry, hooks-path planning + chaining, event
  building against the shared schema); `pnpm test` green.

## For Phase 3

- **Deferred here on purpose** (spec §4.3 items 3–4, §4.4): writing the MCP
  server entry into Claude Code / Cursor config, and installing Claude Code
  hooks into `~/.claude/settings.json`. The setup CLI is structured to absorb
  these — add an `mcp.ts` / `cc-hooks.ts` step to `runInstall` and matching
  reversal in `runUninstall`. Consult current Claude Code hooks docs for event
  names/schema (don't rely on memory).
- `agent.js` already emits `source: "git_hook"`. Phase 3's events use `mcp` /
  `cc_hook`; the shared schemas + `IngestClient` are the same contract.
- The device-auth `approve` route is an **unauthenticated stand-in**. Phase 4
  must SSO-gate it (derive the user from the session) and add the `/activate`
  page the CLI already points people to. Consider encrypting or shortening the
  parked `token_plaintext` window further at that point.
- `status` reads `~/.devpulse/last-send.json`; extend it once MCP/CC events flow.
