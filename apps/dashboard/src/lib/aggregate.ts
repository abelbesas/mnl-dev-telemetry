/**
 * Team-aggregate math (spec §4.5 Team view): estimate-compression ratio over
 * time, AI-assisted vs non-AI cohort comparison, and throughput. Pure and
 * deterministic so it can be unit-tested without a DB; the team page feeds it
 * rows and renders the results. Leads see aggregates only — there is no
 * per-individual drill-down here (spec §4.5), so nothing keyed by user leaves
 * these functions.
 */

export interface AggSession {
  issueKey: string | null;
  startedAt: Date;
  reportedSeconds: number;
  aiAssisted: boolean;
}

export interface AggEstimate {
  issueKey: string;
  estimateSeconds: number;
}

/** Monday 00:00 UTC of the week containing `d` — the week bucket key. */
export function weekStart(d: Date): Date {
  const day = d.getUTCDay(); // 0 = Sun .. 6 = Sat
  const diff = (day + 6) % 7; // days since Monday
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diff),
  );
}

interface TicketRoll {
  issueKey: string;
  actualSeconds: number;
  aiAssisted: boolean;
  firstActivity: Date;
  lastActivity: Date;
}

/** Roll sessions up to one record per ticket (ignoring key-less sessions). */
export function ticketRollup(sessions: AggSession[]): TicketRoll[] {
  const map = new Map<string, TicketRoll>();
  for (const s of sessions) {
    if (!s.issueKey) continue;
    const existing = map.get(s.issueKey);
    if (existing) {
      existing.actualSeconds += s.reportedSeconds;
      existing.aiAssisted ||= s.aiAssisted;
      if (s.startedAt < existing.firstActivity) existing.firstActivity = s.startedAt;
      if (s.startedAt > existing.lastActivity) existing.lastActivity = s.startedAt;
    } else {
      map.set(s.issueKey, {
        issueKey: s.issueKey,
        actualSeconds: s.reportedSeconds,
        aiAssisted: s.aiAssisted,
        firstActivity: s.startedAt,
        lastActivity: s.startedAt,
      });
    }
  }
  return [...map.values()];
}

export interface WeeklyCompression {
  weekStart: Date;
  ticketCount: number;
  actualHours: number;
  estimateHours: number;
  /** actual / estimate, aggregated over the week's completed tickets. <1 = under. */
  ratio: number;
}

/**
 * Estimate-compression ratio per week, bucketed by each ticket's *completion*
 * week (its last activity). Only tickets with a recorded estimate count.
 */
export function compressionByWeek(
  sessions: AggSession[],
  estimates: AggEstimate[],
): WeeklyCompression[] {
  const estMap = new Map(estimates.map((e) => [e.issueKey, e.estimateSeconds]));
  const buckets = new Map<
    number,
    { weekStart: Date; actual: number; estimate: number; tickets: number }
  >();

  for (const t of ticketRollup(sessions)) {
    const est = estMap.get(t.issueKey);
    if (!est || est <= 0) continue;
    const ws = weekStart(t.lastActivity);
    const key = ws.getTime();
    const b = buckets.get(key) ?? {
      weekStart: ws,
      actual: 0,
      estimate: 0,
      tickets: 0,
    };
    b.actual += t.actualSeconds;
    b.estimate += est;
    b.tickets += 1;
    buckets.set(key, b);
  }

  return [...buckets.values()]
    .sort((a, b) => a.weekStart.getTime() - b.weekStart.getTime())
    .map((b) => ({
      weekStart: b.weekStart,
      ticketCount: b.tickets,
      actualHours: round1(b.actual / 3600),
      estimateHours: round1(b.estimate / 3600),
      ratio: b.estimate > 0 ? round2(b.actual / b.estimate) : 0,
    }));
}

export interface CohortStat {
  tickets: number;
  avgActualHours: number;
  /** Mean actual/estimate across tickets that have an estimate. */
  avgRatio: number;
}

export interface CohortComparison {
  ai: CohortStat;
  nonAi: CohortStat;
}

/** Compare AI-assisted vs non-AI tickets (spec §4.5 cohort comparison). */
export function cohortComparison(
  sessions: AggSession[],
  estimates: AggEstimate[],
): CohortComparison {
  const estMap = new Map(estimates.map((e) => [e.issueKey, e.estimateSeconds]));
  const tickets = ticketRollup(sessions);

  const build = (rows: TicketRoll[]): CohortStat => {
    if (rows.length === 0) return { tickets: 0, avgActualHours: 0, avgRatio: 0 };
    const totalActual = rows.reduce((a, r) => a + r.actualSeconds, 0);
    const ratios: number[] = [];
    for (const r of rows) {
      const est = estMap.get(r.issueKey);
      if (est && est > 0) ratios.push(r.actualSeconds / est);
    }
    return {
      tickets: rows.length,
      avgActualHours: round1(totalActual / rows.length / 3600),
      avgRatio:
        ratios.length > 0
          ? round2(ratios.reduce((a, r) => a + r, 0) / ratios.length)
          : 0,
    };
  };

  return {
    ai: build(tickets.filter((t) => t.aiAssisted)),
    nonAi: build(tickets.filter((t) => !t.aiAssisted)),
  };
}

export interface WeeklyThroughput {
  weekStart: Date;
  tickets: number;
  hours: number;
}

/** Throughput per week: distinct tickets touched + reported hours (spec §4.5). */
export function throughputByWeek(sessions: AggSession[]): WeeklyThroughput[] {
  const buckets = new Map<
    number,
    { weekStart: Date; tickets: Set<string>; seconds: number }
  >();
  for (const s of sessions) {
    const ws = weekStart(s.startedAt);
    const key = ws.getTime();
    const b = buckets.get(key) ?? {
      weekStart: ws,
      tickets: new Set<string>(),
      seconds: 0,
    };
    if (s.issueKey) b.tickets.add(s.issueKey);
    b.seconds += s.reportedSeconds;
    buckets.set(key, b);
  }
  return [...buckets.values()]
    .sort((a, b) => a.weekStart.getTime() - b.weekStart.getTime())
    .map((b) => ({
      weekStart: b.weekStart,
      tickets: b.tickets.size,
      hours: round1(b.seconds / 3600),
    }));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
