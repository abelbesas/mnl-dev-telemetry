import { NextResponse } from "next/server";
import { runRollup } from "@/lib/rollup-run";
import { runStitch } from "@/lib/stitch-run";
import { runSync } from "@/lib/sync-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Sync can make several Jira/Tempo round-trips per draft; give it room.
export const maxDuration = 300;

/**
 * The single nightly job (spec §4.2 step 5, brief §6C).
 *
 * Three stages in one route because **Vercel Hobby allows only one cron per
 * day** — and they must run in this order anyway:
 *   1. stitch  — rebuild task_sessions from the event log
 *   2. rollup  — group sessions into worklog drafts (idempotent)
 *   3. sync    — retry approved drafts whose push previously failed
 *
 * Every stage is independently idempotent, so re-running is always safe. A
 * failure in one stage is reported, not thrown, so a Jira outage can't stop the
 * stitcher from having done its job.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const results: Record<string, unknown> = {};

  try {
    results.stitch = await runStitch();
  } catch (err) {
    results.stitch = { error: message(err) };
    // Without sessions there is nothing to roll up; stop here rather than
    // writing drafts from a half-built table.
    return NextResponse.json({ ok: false, ...results }, { status: 200 });
  }

  try {
    results.rollup = await runRollup();
  } catch (err) {
    results.rollup = { error: message(err) };
    return NextResponse.json({ ok: false, ...results }, { status: 200 });
  }

  // Retry pass for drafts approved earlier whose push failed. Per-draft errors
  // are recorded on the row, so this resolves rather than throws.
  try {
    const sync = await runSync();
    results.sync = {
      synced: sync.synced,
      failed: sync.failed,
      skipped: sync.skipped,
    };
  } catch (err) {
    results.sync = { error: message(err) };
  }

  return NextResponse.json({ ok: true, ...results }, { status: 200 });
}

// Vercel Cron issues GET; accept both.
export const GET = POST;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
