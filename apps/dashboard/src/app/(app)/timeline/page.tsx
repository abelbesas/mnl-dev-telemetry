import Link from "next/link";
import { MiniBar } from "@/components/charts";
import {
  dayKey,
  formatClock,
  formatDay,
  formatDuration,
  toHours,
} from "@/lib/format";
import { getUser, getUserSessions } from "@/lib/queries";
import { weekRange } from "@/lib/range";
import { requireUser } from "@/lib/session";
import { runStitch } from "@/lib/stitch-run";
import type { TaskSessionRow } from "@/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function TimelinePage() {
  const sessionUser = await requireUser();
  const user = (await getUser(sessionUser.id))!;
  const tz = user.tz;
  const now = new Date();
  const range = weekRange(now, tz);

  // Rebuild THIS user's sessions on load so a fresh commit shows up on refresh
  // without waiting for the (daily, on Vercel Hobby) cron. Idempotent + scoped
  // to one dev, so it's cheap; a stitch failure must never blank the page.
  try {
    await runStitch({ userId: sessionUser.id });
  } catch (err) {
    console.error("timeline: on-load stitch failed", err);
  }

  const sessions = await getUserSessions(sessionUser.id, range);

  const totalReported = sessions.reduce((a, s) => a + s.reportedSeconds, 0);
  const aiReported = sessions
    .filter((s) => s.aiAssisted)
    .reduce((a, s) => a + s.reportedSeconds, 0);
  const tasks = new Set(sessions.map((s) => s.issueKey ?? s.repo ?? "—"));
  const aiSharePct =
    totalReported > 0 ? Math.round((aiReported / totalReported) * 100) : 0;
  const maxReported = Math.max(1, ...sessions.map((s) => s.reportedSeconds));

  // Group by local calendar day (most recent first).
  const groups = new Map<string, TaskSessionRow[]>();
  for (const s of sessions) {
    const key = dayKey(s.startedAt, tz);
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(s);
  }

  return (
    <div>
      <div className="page-head">
        <h1>My timeline</h1>
        <p>
          This week ({formatDay(range.from, tz)} – today), {tz}. Reported time is
          clamped to your working hours; raw span is shown alongside.
        </p>
      </div>

      <div className="grid cols-3" style={{ marginBottom: "1.5rem" }}>
        <div className="card stat">
          <div className="label">Reported this week</div>
          <div className="value">{toHours(totalReported)}h</div>
          <div className="sub">{sessions.length} sessions</div>
        </div>
        <div className="card stat">
          <div className="label">AI-assisted share</div>
          <div className="value">{aiSharePct}%</div>
          <div className="sub">{toHours(aiReported)}h with an AI agent</div>
        </div>
        <div className="card stat">
          <div className="label">Tasks touched</div>
          <div className="value">{tasks.size}</div>
          <div className="sub">distinct tickets / branches</div>
        </div>
      </div>

      {sessions.length === 0 ? (
        <div className="notice">
          No sessions this week yet. Commit on an instrumented machine (or run the
          demo seed) and the stitcher will populate your timeline.
        </div>
      ) : null}

      {[...groups.entries()].map(([key, daySessions]) => {
        const dayTotal = daySessions.reduce((a, s) => a + s.reportedSeconds, 0);
        return (
          <div className="day-group" key={key}>
            <div className="day-label">
              {formatDay(daySessions[0]!.startedAt, tz)} · {formatDuration(dayTotal)}
            </div>
            {daySessions.map((s) => (
              <SessionRow key={s.id} s={s} tz={tz} max={maxReported} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function SessionRow({
  s,
  tz,
  max,
}: {
  s: TaskSessionRow;
  tz: string;
  max: number;
}) {
  const rawSeconds = Math.round(
    (s.endedAt.getTime() - s.startedAt.getTime()) / 1000,
  );
  const label = s.issueKey ?? s.repo ?? "untitled";
  return (
    <div className="session-row">
      <div className="key">
        {s.issueKey ? (
          <Link href={`/tasks/${encodeURIComponent(s.issueKey)}`}>{label}</Link>
        ) : (
          label
        )}
      </div>
      <div className="time">
        {formatClock(s.startedAt, tz)}–{formatClock(s.endedAt, tz)}
      </div>
      {s.aiAssisted ? (
        <span className="badge ai">✦ {s.aiTool ?? "AI"}</span>
      ) : null}
      <div className="bar-wrap">
        <MiniBar
          value={s.reportedSeconds}
          max={max}
          color={s.aiAssisted ? "var(--ai)" : "var(--accent-strong)"}
        />
      </div>
      <div className="time" style={{ minWidth: 130, textAlign: "right" }}>
        <strong style={{ color: "var(--text)" }}>
          {formatDuration(s.reportedSeconds)}
        </strong>
        {rawSeconds !== s.reportedSeconds ? (
          <span className="muted"> · {formatDuration(rawSeconds)} raw</span>
        ) : null}
      </div>
    </div>
  );
}
