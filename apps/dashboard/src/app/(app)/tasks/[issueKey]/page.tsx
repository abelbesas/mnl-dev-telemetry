import { revalidatePath } from "next/cache";
import Link from "next/link";
import { BarChart } from "@/components/charts";
import { EstimateForm, type EstimateState } from "@/components/EstimateForm";
import { InfoTip } from "@/components/InfoTip";
import {
  formatClock,
  formatDay,
  formatDuration,
  toHours,
} from "@/lib/format";
import {
  canComputeRatio,
  compressionRatio,
  syncEstimateFromJira,
} from "@/lib/estimates";
import { getTaskDetail, upsertEstimate } from "@/lib/queries";
import { requireUser } from "@/lib/session";
import { runStitch } from "@/lib/stitch-run";

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

  // Keep this user's sessions current on load (see timeline note).
  try {
    await runStitch({ userId: user.id });
  } catch (err) {
    console.error("task detail: on-load stitch failed", err);
  }

  // Pull the real estimate from Jira before reading (brief §6B). This never
  // throws — a Jira outage becomes a line of text below, not a 500.
  const estimateSync = await syncEstimateFromJira(user.id, issueKey);

  const detail = await getTaskDetail(user.id, issueKey);

  async function saveEstimate(
    _state: EstimateState,
    formData: FormData,
  ): Promise<EstimateState> {
    "use server";
    const u = await requireUser();
    const key = String(formData.get("issueKey"));
    const hours = Number(formData.get("hours"));
    if (!Number.isFinite(hours) || hours < 0) {
      return { ok: false, message: "Enter a valid number of hours." };
    }
    await upsertEstimate(key, Math.round(hours * 3600), u.id);
    revalidatePath(`/tasks/${encodeURIComponent(key)}`);
    return { ok: true, message: `Estimate saved: ${hours}h on ${key}` };
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

  const {
    actualSeconds,
    rawSeconds,
    estimateSeconds,
    estimateSource,
    aiAssisted,
    aiTools,
  } = detail;
  // A zero/absent estimate yields no ratio at all — dividing by it produced a
  // nonsense "0.01×" before (brief §6B, known gap).
  const ratio = compressionRatio(actualSeconds, estimateSeconds);
  const hasEstimate = canComputeRatio(estimateSeconds);
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

      <div className="grid cols-3" style={{ marginBottom: "1.5rem" }}>
        <div className="card stat">
          <div className="label">
            Estimate
            <InfoTip text="The planned time for this ticket, pulled from the ticket's original estimate in Jira. Teams that estimate in story points leave it empty — you can set one by hand instead." />
          </div>
          <div className="value">
            {hasEstimate ? `${toHours(estimateSeconds!)}h` : "—"}
          </div>
          <div className="sub">
            {!hasEstimate
              ? "no estimate in Jira"
              : estimateSource === "jira"
                ? "from Jira"
                : "set by hand"}
          </div>
        </div>
        <div className="card stat">
          <div className="label">
            Actual (reported)
            <InfoTip text="Your real time on this ticket inside working hours, summed from all your sessions. This is what would be logged to Jira." />
          </div>
          <div className="value">{toHours(actualSeconds)}h</div>
          <div className="sub">
            {detail.sessions.length} sessions
            {/* Raw only earns space when the working-hours clamp actually
                trimmed something. */}
            {toHours(rawSeconds) !== toHours(actualSeconds)
              ? ` · ${toHours(rawSeconds)}h raw`
              : ""}
          </div>
        </div>
        <div className="card stat">
          <div className="label">
            Compression
            <InfoTip text="Actual ÷ Estimate. Under 1 means you beat the estimate, over 1 means it took longer. Example: 0.5× = half the estimated time." />
          </div>
          <div className="value" style={{ color: ratioColor }}>
            {ratio != null ? `${ratio.toFixed(2)}×` : "—"}
          </div>
          <div className="sub">
            {deltaPct == null
              ? "needs an estimate"
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
                value: hasEstimate ? toHours(estimateSeconds!) : 0,
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
          <EstimateForm
            action={saveEstimate}
            issueKey={issueKey}
            defaultHours={hasEstimate ? toHours(estimateSeconds!) : ""}
          />
          <p className="muted" style={{ fontSize: "0.8rem", marginTop: "0.75rem" }}>
            {estimateSync.message}
            {estimateSync.status === "no-estimate" ? (
              <>
                {" "}
                Story points live in a per-instance custom field we don&apos;t
                read, so set hours here if you want a compression ratio.
              </>
            ) : null}
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
