import { NextResponse } from "next/server";
import { runStitch } from "@/lib/stitch-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Scheduled stitching trigger (spec §4.2: "run on a schedule — cron route or
 * Vercel cron"). Rebuilds `task_sessions` from the append-only event log for all
 * users. Idempotent and deterministic, so it is safe to run on any cadence.
 *
 * Protected by CRON_SECRET when set (Vercel Cron sends it as a Bearer token);
 * open in local dev when unset.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }
  const result = await runStitch();
  return NextResponse.json(result, { status: 200 });
}

// Vercel Cron issues GET; accept both.
export const GET = POST;
