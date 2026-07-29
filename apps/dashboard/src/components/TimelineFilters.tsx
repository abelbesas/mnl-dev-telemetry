import Link from "next/link";

/**
 * Timeline noise filters. Driven by URL search params so the whole page stays a
 * server component (no client JS, survives refresh, shareable link).
 *
 * "Ticketed only" is the useful one day to day: sessions whose branch had no
 * issue key (`main`, `fix-stuff`, …) can't attach to a ticket, so they're noise
 * on a timeline you're reading per-ticket. Hidden counts are always shown — we
 * never silently drop rows.
 */

export interface TimelineFilterState {
  ticketedOnly: boolean;
  hideEmpty: boolean;
}

export function parseTimelineFilters(params: {
  ticketed?: string;
  nonzero?: string;
}): TimelineFilterState {
  return {
    ticketedOnly: params.ticketed === "1",
    hideEmpty: params.nonzero === "1",
  };
}

/** The shape the filter cares about — keeps this testable without a DB row. */
export interface FilterableSession {
  issueKey: string | null;
  reportedSeconds: number;
}

/**
 * Apply the active filters. Pure, so the "what counts as noise" rule is
 * unit-tested rather than buried in JSX.
 */
export function filterSessions<T extends FilterableSession>(
  sessions: T[],
  state: TimelineFilterState,
): T[] {
  return sessions.filter((s) => {
    if (state.ticketedOnly && !s.issueKey) return false;
    if (state.hideEmpty && s.reportedSeconds <= 0) return false;
    return true;
  });
}

function hrefWith(state: TimelineFilterState): string {
  const q = new URLSearchParams();
  if (state.ticketedOnly) q.set("ticketed", "1");
  if (state.hideEmpty) q.set("nonzero", "1");
  const s = q.toString();
  return s ? `/timeline?${s}` : "/timeline";
}

export function TimelineFilters({
  state,
  hiddenCount,
  noKeyCount,
}: {
  state: TimelineFilterState;
  /** Rows actually hidden by the active filters (never double-counted). */
  hiddenCount: number;
  /** Sessions with no ticket key, for the idle hint. */
  noKeyCount: number;
}) {
  const anyActive = state.ticketedOnly || state.hideEmpty;

  return (
    <div className="filter-bar">
      <span className="filter-label">Filter</span>

      <Link
        href={hrefWith({ ...state, ticketedOnly: !state.ticketedOnly })}
        className={`chip ${state.ticketedOnly ? "on" : ""}`}
        title="Hide sessions whose branch had no ticket key (main, fix-stuff, …)"
      >
        {state.ticketedOnly ? "✓ " : ""}Ticketed only
      </Link>

      <Link
        href={hrefWith({ ...state, hideEmpty: !state.hideEmpty })}
        className={`chip ${state.hideEmpty ? "on" : ""}`}
        title="Hide sessions with 0m of reported time"
      >
        {state.hideEmpty ? "✓ " : ""}Hide 0m
      </Link>

      {anyActive ? (
        <>
          <span className="filter-note">
            {hiddenCount} {hiddenCount === 1 ? "session" : "sessions"} hidden
          </span>
          <Link href="/timeline" className="chip subtle">
            Clear
          </Link>
        </>
      ) : (
        <span className="filter-note">
          {noKeyCount > 0
            ? `${noKeyCount} without a ticket key`
            : "all sessions have a ticket key"}
        </span>
      )}
    </div>
  );
}
