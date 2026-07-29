import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { IngestClient } from "@mnl-dev-telemetry/shared";
import { readCredentials } from "./credentials";
import { collectContext } from "./git";
import { buildEvent, type HookName } from "./event";
import { mnlDevTelemetryPaths } from "./paths";
import { flushSpool, readSpool, writeSpool } from "./spool";

/**
 * The git-hook agent (`~/.devpulse/agent.js`). Invoked as
 * `node agent.js <hook> [git-args...]`. Design contract (spec §4.3, item 2):
 *
 *  - Never throw out of the process: any error path still exits 0 so git is
 *    unaffected. (The shell wrapper also backgrounds us, so git never waits.)
 *  - 2s network budget via the IngestClient timeout.
 *  - Build the current event, prepend any spooled events, try to send the
 *    batch; on failure (offline, API down) persist everything back to the spool
 *    for the next invocation. Idempotent by event_uuid, so retries are safe.
 */

const VALID_HOOKS: readonly HookName[] = [
  "post-commit",
  "post-checkout",
  "pre-push",
];

async function main(): Promise<void> {
  const hook = process.argv[2] as HookName | undefined;
  if (!hook || !VALID_HOOKS.includes(hook)) return;
  const gitArgs = process.argv.slice(3);

  const paths = mnlDevTelemetryPaths();
  const creds = readCredentials(paths.credentials);
  if (!creds) return; // not logged in — silently do nothing

  const fresh = (() => {
    try {
      const ctx = collectContext(hook, gitArgs);
      const event = buildEvent(ctx, {
        uuid: randomUUID(),
        ts: new Date().toISOString(),
      });
      return event ? [event] : [];
    } catch {
      return [];
    }
  })();

  const pending = readSpool(paths.spool);

  const client = new IngestClient({
    baseUrl: creds.baseUrl,
    token: creds.token,
    timeoutMs: 2000,
  });

  const result = await flushSpool({
    pending,
    fresh,
    send: async (events) => {
      await client.sendEvents(events);
    },
  });

  writeSpool(paths.spool, result.remaining);

  // Small breadcrumb for `status` (best-effort; never fatal).
  try {
    fs.writeFileSync(
      paths.lastSend,
      JSON.stringify({
        at: new Date().toISOString(),
        hook,
        attempted: result.attempted,
        ok: result.sent,
        spooled: result.remaining.length,
        dropped: result.dropped,
      }),
    );
  } catch {
    /* ignore */
  }
}

main()
  .catch(() => {
    /* never surface an error to git */
  })
  .finally(() => {
    process.exit(0);
  });
