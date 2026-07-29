import type { HookName } from "./event";

/**
 * POSIX shell hook scripts written to `~/.devpulse/hooks/`. They are the thin
 * layer git actually invokes; all real logic lives in the bundled Node
 * `agent.js` (spec §1: "Git hooks are POSIX shell calling a small Node script").
 *
 * Two hard guarantees encoded here (spec §4.3, item 2 + edge case):
 *  1. Never block or break git — the telemetry call is backgrounded and fully
 *     detached (stdin/stdout/stderr redirected), so the hook returns instantly
 *     regardless of network/API state. The agent enforces its own 2s timeout.
 *  2. Chain any pre-existing hooks path — if a global `core.hooksPath` was set
 *     before us (husky, custom), call its same-named hook after ours and
 *     propagate its exit code, so we never swallow a dev's existing gate.
 */

export const HOOK_NAMES: readonly HookName[] = [
  "post-commit",
  "post-checkout",
  "pre-push",
];

const HEADER = (hook: HookName) => `#!/bin/sh
# MnlDevTelemetry ${hook} hook — managed by @mnl-dev-telemetry/setup. Do not edit.
# Regenerate with \`npx @mnl-dev-telemetry/setup install\`; remove with \`--uninstall\`.
set +e
DEVPULSE_HOME="\${DEVPULSE_HOME:-$HOME/.devpulse}"
HOOK="${hook}"
`;

const FIRE_AND_FORGET = `# Fire-and-forget telemetry: backgrounded + fully detached so git never waits.
if command -v node >/dev/null 2>&1 && [ -f "$DEVPULSE_HOME/agent.js" ]; then
  node "$DEVPULSE_HOME/agent.js" "$HOOK" "$@" </dev/null >/dev/null 2>&1 &
fi
`;

const READ_PREV = `PREV=""
if [ -f "$DEVPULSE_HOME/previous-hooks-path" ]; then
  PREV="$(cat "$DEVPULSE_HOME/previous-hooks-path" 2>/dev/null)"
fi
`;

/** post-commit / post-checkout: no stdin from git, simple chaining. */
function standardHook(hook: HookName): string {
  return `${HEADER(hook)}
${FIRE_AND_FORGET}
${READ_PREV}
if [ -n "$PREV" ] && [ -x "$PREV/$HOOK" ]; then
  "$PREV/$HOOK" "$@"
  exit $?
fi
exit 0
`;
}

/**
 * pre-push receives ref updates on stdin, which a chained hook may need. We
 * capture stdin to a temp file and feed it to the chained hook; our own agent
 * reads nothing from stdin (`</dev/null`) so it can never block the push.
 */
function prePushHook(): string {
  return `${HEADER("pre-push")}
${READ_PREV}
if [ -n "$PREV" ] && [ -x "$PREV/$HOOK" ]; then
  STDIN_TMP="$(mktemp 2>/dev/null || echo "\${TMPDIR:-/tmp}/mnl-dev-telemetry-prepush.$$")"
  cat > "$STDIN_TMP"
${FIRE_AND_FORGET}  "$PREV/$HOOK" "$@" < "$STDIN_TMP"
  CODE=$?
  rm -f "$STDIN_TMP"
  exit $CODE
fi
${FIRE_AND_FORGET}exit 0
`;
}

export function hookScript(hook: HookName): string {
  return hook === "pre-push" ? prePushHook() : standardHook(hook);
}
