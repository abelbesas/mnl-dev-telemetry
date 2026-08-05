/**
 * Minimal dependency-free SVG charts for the team view (spec §4.5: "the charts
 * that matter — compression ratio trend, AI vs non-AI cohort bars"). Pure
 * render, computed server-side; no chart library.
 */

export interface Bar {
  label: string;
  value: number;
  color?: string;
  sub?: string;
}

export function BarChart({
  data,
  unit = "",
  max,
}: {
  data: Bar[];
  unit?: string;
  max?: number;
}) {
  const barW = 64;
  const gap = 40;
  const padL = 16;
  const padR = 16;
  const padT = 24;
  const padB = 44;
  const chartH = 170;
  const peak = Math.max(max ?? 0, 1, ...data.map((d) => d.value));
  const w = padL + padR + data.length * barW + Math.max(0, data.length - 1) * gap;
  const h = padT + chartH + padB;

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      style={{ width: "100%", height: "auto", maxWidth: w }}
      role="img"
    >
      <line
        x1={padL}
        y1={padT + chartH}
        x2={w - padR}
        y2={padT + chartH}
        stroke="var(--border)"
      />
      {data.map((d, i) => {
        const x = padL + i * (barW + gap);
        const bh = (d.value / peak) * chartH;
        const y = padT + chartH - bh;
        return (
          <g key={d.label}>
            <rect
              x={x}
              y={y}
              width={barW}
              height={Math.max(0, bh)}
              rx={5}
              fill={d.color ?? "var(--accent-strong)"}
            />
            <text
              x={x + barW / 2}
              y={y - 7}
              textAnchor="middle"
              fontSize="13"
              fontWeight="700"
              fill="var(--text)"
            >
              {d.value}
              {unit}
            </text>
            <text
              x={x + barW / 2}
              y={padT + chartH + 18}
              textAnchor="middle"
              fontSize="12"
              fill="var(--muted)"
            >
              {d.label}
            </text>
            {d.sub ? (
              <text
                x={x + barW / 2}
                y={padT + chartH + 34}
                textAnchor="middle"
                fontSize="11"
                fill="var(--muted)"
              >
                {d.sub}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

export interface TrendPoint {
  label: string;
  value: number;
}

/** Line chart for the weekly compression-ratio trend, with a 1.0 reference. */
export function LineChart({
  points,
  refLine,
  format = (v) => String(v),
}: {
  points: TrendPoint[];
  refLine?: number;
  format?: (v: number) => string;
}) {
  const padL = 40;
  const padR = 20;
  const padT = 20;
  const padB = 40;
  const chartH = 170;
  const stepW = 90;
  const w = padL + padR + Math.max(1, points.length - 1) * stepW;
  const h = padT + chartH + padB;
  const peak = Math.max(1.1, refLine ?? 0, ...points.map((p) => p.value)) * 1.1;

  const xy = (i: number, v: number): [number, number] => [
    padL + i * stepW,
    padT + chartH - (v / peak) * chartH,
  ];
  const path = points
    .map((p, i) => {
      const [x, y] = xy(i, p.value);
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");

  const refY = refLine != null ? padT + chartH - (refLine / peak) * chartH : null;

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      style={{ width: "100%", height: "auto", maxWidth: w }}
      role="img"
    >
      {/* y axis ticks */}
      {[0, peak / 2, peak].map((v, i) => {
        const y = padT + chartH - (v / peak) * chartH;
        return (
          <g key={i}>
            <line x1={padL} y1={y} x2={w - padR} y2={y} stroke="var(--border)" strokeDasharray="2 4" />
            <text x={padL - 6} y={y + 4} textAnchor="end" fontSize="10" fill="var(--muted)">
              {v.toFixed(1)}
            </text>
          </g>
        );
      })}
      {refY != null ? (
        <line
          x1={padL}
          y1={refY}
          x2={w - padR}
          y2={refY}
          stroke="var(--warn)"
          strokeDasharray="5 4"
        />
      ) : null}
      <path d={path} fill="none" stroke="var(--accent)" strokeWidth="2.5" />
      {points.map((p, i) => {
        const [x, y] = xy(i, p.value);
        return (
          <g key={p.label}>
            <circle cx={x} cy={y} r={4} fill="var(--accent)" />
            <text x={x} y={y - 10} textAnchor="middle" fontSize="11" fontWeight="600" fill="var(--text)">
              {format(p.value)}
            </text>
            <text x={x} y={padT + chartH + 18} textAnchor="middle" fontSize="11" fill="var(--muted)">
              {p.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
