import { revalidatePath } from "next/cache";
import Link from "next/link";
import { BarChart } from "@/components/charts";
import {
  formatClock,
  formatDay,
  formatDuration,
  toHours,
} from "@/lib/format";
import { getTaskDetail, upsertEstimate } from "@/lib/queries";
import { requireUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function TaskDetailPage({
  params,
}: {
  params: Promise<{ issueKey: string }>;
}) {
  const user = await requireUser();
  const { issueKey: rawKey } = await params;
  const issueKey = decodeURIComponent(rawKey);
  const detail = await getTaskDetail(user.id, issueKey);

  async function saveEstimate(formData: FormData) {
    "use server";
    const u = await requireUser();
    const key = String(formData.get("issueKey"));
    const hours = Number(formData.get("hours"));
    if (Number.isFinite(hours) && hours >= 0) {
      await upsertEstimate(key, Math.round(hours * 3600), u.id);
    }
    revalidatePath(`/tasks/${encodeURIComponent(key)}`);
  }

  if (!detail) {
    return (
      <div>
        <div className="page-head">
          <h1>{issueKey}</h1>
          <p>
            <Link href="/timeline">← My timeline</Link>
          </p>
        </div>
        <div className="notice">
          You have no sessions on {issueKey}. Task detail shows your own time only
          (spec §2.6).
        </div>
      </div>
    );
  }

  const { actualSeconds, rawSeconds, estimateSeconds, aiAssisted, aiTools } =
    detail;
  const ratio =
    estimateSeconds && estimateSeconds > 0
      ? actualSeconds / estimateSeconds
      : null;
  const ratioColor =
    ratio == null
      ? "var(--muted)"
      : ratio <= 1
        ? "var(--good)"
        : ratio <= 1.25
          ? "var(--warn)"
          : "var(--bad)";
  const deltaPct = ratio != null ? Math.round((ratio - 1) * 100) : null;

  return (
    <div>
      <div className="page-head">
        <h1>
          {issueKey}{" "}
          {aiAssisted ? (
            <span className="badge ai" style={{ verticalAlign: "middle" }}>
              ✦ {aiTools.join(", ") || "AI"}
            </span>
          ) : null}
        </h1>
        <p>
          <Link href="/timeline">← My timeline</Link> · your time on this ticket
        </p>
      </div>

      <div className="grid cols-4" style={{ marginBottom: "1.5rem" }}>
        <div className="card stat">
          <div className="label">Estimate</div>
          <div className="value">
            {estimateSeconds ? `${toHours(estimateSeconds)}h` : "—"}
          </div>
          <div className="sub">manual (Jira sync in Phase 5)</div>
        </div>
        <div className="card stat">
          <div className="label">Actual (reported)</div>
          <div className="value">{toHours(actualSeconds)}h</div>
          <div className="sub">{detail.sessions.length} sessions</div>
        </div>
        <div className="card stat">
          <div className="label">Raw span</div>
          <div className="value">{toHours(rawSeconds)}h</div>
          <div className="sub">before working-hours clamp</div>
        </div>
        <div className="card stat">
          <div className="label">Compression</div>
          <div className="value" style={{ color: ratioColor }}>
            {ratio != null ? `${ratio.toFixed(2)}×` : "—"}
          </div>
          <div className="sub">
            {deltaPct == null
              ? "set an estimate"
              : deltaPct === 0
                ? "on estimate"
                : deltaPct < 0
                  ? `${-deltaPct}% under`
                  : `${deltaPct}% over`}
          </div>
        </div>
      </div>

      <div className="grid cols-2" style={{ marginBottom: "1.5rem" }}>
        <div className="card">
          <h3>Estimate vs actual</h3>
          <BarChart
            unit="h"
            data={[
              {
                label: "Estimate",
                value: estimateSeconds ? toHours(estimateSeconds) : 0,
                color: "var(--muted)",
              },
              {
                label: "Actual",
                value: toHours(actualSeconds),
                color: aiAssisted ? "var(--ai)" : "var(--accent-strong)",
              },
            ]}
          />
        </div>
        <div className="card">
          <h3>Set estimate</h3>
          <form action={saveEstimate}>
            <input type="hidden" name="issueKey" value={issueKey} />
            <label className="field">
              <span>Estimate (hours)</span>
              <input
                type="number"
                name="hours"
                min="0"
                step="0.25"
                defaultValue={estimateSeconds ? toHours(estimateSeconds) : ""}
                placeholder="e.g. 8"
              />
            </label>
            <button className="btn" type="submit">
              Save estimate
            </button>
          </form>
          <p className="muted" style={{ fontSize: "0.8rem", marginTop: "0.75rem" }}>
            Estimates are a manual field in the MVP; Phase 5 populates them from
            Jira.
          </p>
        </div>
      </div>

      <div className="card">
        <h3>Sessions</h3>
        <table>
          <thead>
            <tr>
              <th>Day</th>
              <th>Time</th>
              <th>AI</th>
              <th className="num">Reported</th>
              <th className="num">Raw</th>
              <th className="num">Events</th>
            </tr>
          </thead>
          <tbody>
            {detail.sessions.map((s) => {
              const raw = Math.round(
                (s.endedAt.getTime() - s.startedAt.getTime()) / 1000,
              );
              return (
                <tr key={s.id}>
                  <td>{formatDay(s.startedAt)}</td>
                  <td>
                    {formatClock(s.startedAt)}–{formatClock(s.endedAt)}
                  </td>
                  <td>
                    {s.aiAssisted ? (
                      <span className="badge ai">✦ {s.aiTool ?? "AI"}</span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="num">{formatDuration(s.reportedSeconds)}</td>
                  <td className="num muted">{formatDuration(raw)}</td>
                  <td className="num">{s.eventCount}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
