import { DEFAULT_TZ } from "@mnl-dev-telemetry/shared";
import { BarChart, LineChart } from "@/components/charts";
import { InfoTip } from "@/components/InfoTip";
import {
  cohortComparison,
  compressionByWeek,
  throughputByWeek,
  type AggSession,
} from "@/lib/aggregate";
import { formatShortDay, toHours } from "@/lib/format";
import { getAllEstimates, getAllSessions, getTeamHeadcount } from "@/lib/queries";
import { lastNDays } from "@/lib/range";
import { requireLead } from "@/lib/session";
import { runStitch } from "@/lib/stitch-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function TeamPage() {
  await requireLead();

  // Rebuild everyone's sessions so the aggregates are current without depending
  // on the daily cron (Vercel Hobby). Lead-only + infrequently viewed, so the
  // full rebuild is acceptable; never let a stitch error blank the page.
  try {
    await runStitch();
  } catch (err) {
    console.error("team: on-load stitch failed", err);
  }

  const now = new Date();
  const range = lastNDays(now, DEFAULT_TZ, 28);
  const [rows, estimates, headcount] = await Promise.all([
    getAllSessions(range),
    getAllEstimates(),
    getTeamHeadcount(),
  ]);

  const sessions: AggSession[] = rows.map((s) => ({
    issueKey: s.issueKey,
    startedAt: s.startedAt,
    reportedSeconds: s.reportedSeconds,
    aiAssisted: s.aiAssisted,
  }));

  const weekly = compressionByWeek(sessions, estimates);
  const cohort = cohortComparison(sessions, estimates);
  const throughput = throughputByWeek(sessions);

  const totalHours = toHours(
    sessions.reduce((a, s) => a + s.reportedSeconds, 0),
  );
  const aiTickets = cohort.ai.tickets;
  const totalTickets = cohort.ai.tickets + cohort.nonAi.tickets;
  const aiTicketPct =
    totalTickets > 0 ? Math.round((aiTickets / totalTickets) * 100) : 0;

  return (
    <div>
      <div className="page-head">
        <h1>Team</h1>
        <p>
          Aggregates across {headcount.devs} devs · last 4 weeks · {DEFAULT_TZ}.
          Aggregates only — no per-individual drill-down (spec §4.5).
        </p>
      </div>

      <div className="grid cols-4" style={{ marginBottom: "1.5rem" }}>
        <div className="card stat">
          <div className="label">
            Reported time
            <InfoTip text="Total working-hours time across the whole team in this window (last 4 weeks)." />
          </div>
          <div className="value">{totalHours}h</div>
          <div className="sub">{sessions.length} sessions</div>
        </div>
        <div className="card stat">
          <div className="label">
            Tickets worked
            <InfoTip text="Number of distinct tickets that had any recorded activity in this window." />
          </div>
          <div className="value">{totalTickets}</div>
          <div className="sub">with recorded activity</div>
        </div>
        <div className="card stat">
          <div className="label">
            AI-assisted tickets
            <InfoTip text="Share of worked tickets where at least one session used an AI agent." />
          </div>
          <div className="value">{aiTicketPct}%</div>
          <div className="sub">
            {aiTickets} of {totalTickets}
          </div>
        </div>
        <div className="card stat">
          <div className="label">
            Team
            <InfoTip text="People set up in MnlDevTelemetry (developers plus leads)." />
          </div>
          <div className="value">
            {headcount.devs + headcount.leads}
          </div>
          <div className="sub">
            {headcount.devs} devs · {headcount.leads} leads
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: "1.5rem" }}>
        <h3>Estimate-compression ratio over time</h3>
        {weekly.length > 0 ? (
          <>
            <LineChart
              points={weekly.map((w) => ({
                label: formatShortDay(w.weekStart),
                value: w.ratio,
              }))}
              refLine={1}
              format={(v) => `${v.toFixed(2)}×`}
            />
            <div className="legend">
              <span>
                <span className="dot" style={{ background: "var(--accent)" }} />
                actual ÷ estimate (lower = more compressed)
              </span>
              <span>
                <span className="dot" style={{ background: "var(--warn)" }} />
                1.0× = on estimate
              </span>
            </div>
          </>
        ) : (
          <p className="muted">
            No completed tickets with estimates in this window yet.
          </p>
        )}
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h3>AI-assisted vs not — compression</h3>
          <BarChart
            unit="×"
            data={[
              {
                label: "AI-assisted",
                value: cohort.ai.avgRatio,
                color: "var(--ai)",
                sub: `${cohort.ai.tickets} tickets · ${cohort.ai.avgActualHours}h avg`,
              },
              {
                label: "No AI",
                value: cohort.nonAi.avgRatio,
                color: "var(--accent-strong)",
                sub: `${cohort.nonAi.tickets} tickets · ${cohort.nonAi.avgActualHours}h avg`,
              },
            ]}
          />
          <p className="muted" style={{ fontSize: "0.8rem" }}>
            Mean actual ÷ estimate per ticket. Lower means the cohort came in
            under estimate.
          </p>
        </div>
        <div className="card">
          <h3>Throughput per week</h3>
          <BarChart
            data={throughput.map((w) => ({
              label: formatShortDay(w.weekStart),
              value: w.tickets,
              sub: `${w.hours}h`,
            }))}
          />
          <p className="muted" style={{ fontSize: "0.8rem" }}>
            Distinct tickets touched each week (hours below).
          </p>
        </div>
      </div>
    </div>
  );
}
