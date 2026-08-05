import Link from "next/link";
import { formatDuration } from "@/lib/format";
import type { SessionProgress } from "@/lib/progress";

/**
 * Cumulative burn-down bar for one timeline row (spec: estimate vs actual).
 *
 * Reads left to right as "where this ticket stood after this session":
 *  - a dim segment for time logged earlier,
 *  - a solid segment for what *this* session added,
 *  - red segments for anything past the estimate, with a dashed line marking
 *    where the estimate sat.
 *
 * Hovering (or focusing) shows the exact numbers.
 */
export function TaskProgressBar({
  progress,
  aiAssisted,
}: {
  progress: SessionProgress;
  aiAssisted: boolean;
}) {
  const {
    percent,
    priorWidth,
    sessionWidth,
    overPriorWidth,
    overSessionWidth,
    estimateMarkerPct,
    estimateSeconds,
    cumulativeSeconds,
    sessionSeconds,
    overSeconds,
    remainingSeconds,
    source,
  } = progress;

  const over = overSeconds > 0;
  const sessionColor = aiAssisted ? "var(--ai)" : "var(--accent-strong)";

  const tipLines = [
    `${percent}% of estimate used`,
    `Estimate: ${formatDuration(estimateSeconds)} (${source})`,
    `Logged so far: ${formatDuration(cumulativeSeconds)}`,
    `This session: +${formatDuration(sessionSeconds)}`,
    over
      ? `Over by ${formatDuration(overSeconds)}`
      : `Remaining: ${formatDuration(remainingSeconds)}`,
  ];

  return (
    <span
      className="progress-tip"
      tabIndex={0}
      role="img"
      aria-label={tipLines.join(". ")}
    >
      <span
        className="progress-track"
        // Native tooltip as a fallback for touch / reduced-motion contexts.
        title={tipLines.join("\n")}
      >
        {priorWidth > 0 ? (
          <span
            className="seg seg-prior"
            style={{ width: `${priorWidth}%` }}
          />
        ) : null}
        {sessionWidth > 0 ? (
          <span
            className="seg seg-session"
            style={{ width: `${sessionWidth}%`, background: sessionColor }}
          />
        ) : null}
        {overPriorWidth > 0 ? (
          <span
            className="seg seg-over-prior"
            style={{ width: `${overPriorWidth}%` }}
          />
        ) : null}
        {overSessionWidth > 0 ? (
          <span
            className="seg seg-over-session"
            style={{ width: `${overSessionWidth}%` }}
          />
        ) : null}
        {estimateMarkerPct !== null ? (
          <span
            className="estimate-marker"
            style={{ left: `${estimateMarkerPct}%` }}
          />
        ) : null}
      </span>

      <span className={`progress-pct${over ? " over" : ""}`}>{percent}%</span>

      <span className="tip-bubble">
        {tipLines.map((line) => (
          <span key={line} className="tip-line">
            {line}
          </span>
        ))}
      </span>
    </span>
  );
}

/**
 * Shown instead of a bar when there's nothing to measure against. A ticket with
 * no estimate gets an actionable link (setting one is a click away on Task
 * detail); a session with no ticket key can't have an estimate at all, so it
 * just says so.
 */
export function NoProgress({ issueKey }: { issueKey: string | null }) {
  if (!issueKey) {
    return <span className="no-progress muted">no ticket</span>;
  }
  return (
    <Link
      className="no-progress set-estimate"
      href={`/tasks/${encodeURIComponent(issueKey)}`}
    >
      Set estimate
    </Link>
  );
}
