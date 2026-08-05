/**
 * Timeline progress bars: how far a ticket has burned through its estimate,
 * measured *cumulatively* at each session.
 *
 * The old bar compared a session against the biggest session of the week, which
 * carried no meaning. This one answers the question that matters: "after this
 * session, how much of the estimate is gone?"
 *
 * Cumulative is deliberately **all-time for the ticket**, not just the visible
 * week. An estimate covers the whole ticket, so if 3h of a 2h estimate was
 * already burned last week, a bar reading "25%" for today's 30 minutes would be
 * a lie. `priorSeconds` carries that pre-range total in.
 *
 * Pure and clock-free so the segment math is unit-testable.
 */

/** The minimum a session needs to expose for progress purposes. */
export interface ProgressSession {
  id: string;
  issueKey: string | null;
  startedAt: Date;
  reportedSeconds: number;
}

export interface EstimateInfo {
  estimateSeconds: number;
  source: "manual" | "jira";
}

/**
 * One bar's worth of geometry + numbers. Segment widths are percentages **of
 * the bar container** and always sum to ≤ 100.
 *
 * The bar is scaled so the longest thing shown fits: when a ticket is under
 * estimate the container represents the estimate (100%); once it goes over, the
 * container represents the *total*, and `estimateMarkerPct` marks where the
 * estimate sat — so an overrun is visible as length, not just as a number.
 */
export interface SessionProgress {
  /** Time on this ticket before this session (all-time). */
  priorSeconds: number;
  /** This session's own reported time. */
  sessionSeconds: number;
  /** prior + this session. */
  cumulativeSeconds: number;
  estimateSeconds: number;
  /** Cumulative as a percentage of the estimate, rounded. Can exceed 100. */
  percent: number;
  /** Seconds beyond the estimate (0 when within it). */
  overSeconds: number;
  /** Seconds still available (0 once over). */
  remainingSeconds: number;
  source: "manual" | "jira";

  // --- segment widths, in % of the bar container ---
  /** Earlier sessions, still within estimate. */
  priorWidth: number;
  /** This session's slice, still within estimate. */
  sessionWidth: number;
  /** Earlier sessions, already past the estimate. */
  overPriorWidth: number;
  /** This session's slice past the estimate. */
  overSessionWidth: number;
  /** Position of the estimate line, or null when not over (it's the bar end). */
  estimateMarkerPct: number | null;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Compute one session's bar. `estimateSeconds` must be > 0 — callers should skip
 * bars entirely when a ticket has no estimate (there is nothing to be a
 * percentage of), which is what `computeSessionProgress` does.
 */
export function sessionProgress(
  priorSeconds: number,
  sessionSeconds: number,
  estimate: EstimateInfo,
): SessionProgress {
  const est = estimate.estimateSeconds;
  const prior = Math.max(0, priorSeconds);
  const session = Math.max(0, sessionSeconds);
  const cumulative = prior + session;

  // Work in "percent of estimate" units, then rescale to container width.
  const priorPct = (prior / est) * 100;
  const totalPct = (cumulative / est) * 100;

  const underPrior = Math.min(priorPct, 100);
  const underTotal = Math.min(totalPct, 100);
  const underSession = Math.max(0, underTotal - underPrior);
  const overPrior = Math.max(0, priorPct - 100);
  const overSession = Math.max(0, totalPct - Math.max(priorPct, 100));

  // Container represents the estimate until we exceed it, then the total.
  const denom = Math.max(100, totalPct);
  const w = (pct: number) => round1((pct / denom) * 100);

  return {
    priorSeconds: prior,
    sessionSeconds: session,
    cumulativeSeconds: cumulative,
    estimateSeconds: est,
    percent: Math.round(totalPct),
    overSeconds: Math.max(0, cumulative - est),
    remainingSeconds: Math.max(0, est - cumulative),
    source: estimate.source,
    priorWidth: w(underPrior),
    sessionWidth: w(underSession),
    overPriorWidth: w(overPrior),
    overSessionWidth: w(overSession),
    estimateMarkerPct: totalPct > 100 ? round1((100 / denom) * 100) : null,
  };
}

/**
 * Build progress for every session that has both an issue key and an estimate.
 * Sessions may arrive in any order (the timeline renders newest-first); the
 * cumulative walk is done chronologically, with `id` as a deterministic
 * tie-breaker for identical timestamps.
 *
 * Sessions without an issue key, or on tickets with no estimate, are simply
 * absent from the result — the caller renders those rows without a bar.
 */
export function computeSessionProgress(
  sessions: ProgressSession[],
  estimates: Map<string, EstimateInfo>,
  priorSeconds: Map<string, number>,
): Map<string, SessionProgress> {
  const byKey = new Map<string, ProgressSession[]>();
  for (const s of sessions) {
    if (!s.issueKey) continue;
    const estimate = estimates.get(s.issueKey);
    if (!estimate || estimate.estimateSeconds <= 0) continue;
    const bucket = byKey.get(s.issueKey);
    if (bucket) bucket.push(s);
    else byKey.set(s.issueKey, [s]);
  }

  const out = new Map<string, SessionProgress>();
  for (const [key, group] of byKey) {
    const estimate = estimates.get(key)!;
    const chronological = [...group].sort(
      (a, b) => a.startedAt.getTime() - b.startedAt.getTime() || a.id.localeCompare(b.id),
    );
    let running = priorSeconds.get(key) ?? 0;
    for (const s of chronological) {
      out.set(s.id, sessionProgress(running, s.reportedSeconds, estimate));
      running += Math.max(0, s.reportedSeconds);
    }
  }
  return out;
}
