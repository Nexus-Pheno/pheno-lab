import { Icon } from "@/components/ui";

// Per-group box plots of measured metrics — the picture the technicians build
// by hand in spreadsheets today (box = quartiles, whiskers = full range,
// triangle = mean, dots = individual samples). Server-rendered SVG: the data
// is small and there is nothing to interact with beyond hover titles.

export type MetricPlot = {
  metric: string;
  groups: { label: string; values: { value: number; code: string }[] }[];
};

const quantile = (sorted: number[], q: number): number => {
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};

const short = (v: number): string => {
  const a = Math.abs(v);
  if (a >= 100) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  return v.toPrecision(3);
};

function BoxPlot({ plot }: { plot: MetricPlot }) {
  const groups = plot.groups.filter((g) => g.values.length > 0);
  const all = groups.flatMap((g) => g.values.map((v) => v.value));
  if (!all.length) return null;

  const GW = 84;
  const LEFT = 44;
  const TOP = 14;
  const PLOT_H = 150;
  const BOTTOM = 34;
  const width = LEFT + groups.length * GW + 10;
  const height = TOP + PLOT_H + BOTTOM;

  let lo = Math.min(...all);
  let hi = Math.max(...all);
  const pad = (hi - lo || Math.abs(hi) || 1) * 0.12;
  lo -= pad;
  hi += pad;
  const y = (v: number) => TOP + ((hi - v) / (hi - lo)) * PLOT_H;

  // Four horizontal gridlines with axis labels.
  const ticks = [0, 1, 2, 3].map((i) => lo + ((hi - lo) * (i + 0.5)) / 4);

  return (
    <div className="min-w-0 overflow-x-auto">
      <div className="text-[11px] font-bold text-charcoal mb-0.5">
        {plot.metric}
      </div>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={plot.metric}
      >
        {ticks.map((tv, i) => (
          <g key={i}>
            <line
              x1={LEFT}
              x2={width - 6}
              y1={y(tv)}
              y2={y(tv)}
              stroke="var(--color-line)"
              strokeDasharray="2 3"
            />
            <text
              x={LEFT - 4}
              y={y(tv) + 3}
              textAnchor="end"
              fontSize="8.5"
              fill="var(--color-muted)"
              className="mono"
            >
              {short(tv)}
            </text>
          </g>
        ))}
        {groups.map((g, gi) => {
          const cx = LEFT + gi * GW + GW / 2;
          const sorted = g.values.map((v) => v.value).sort((a, b) => a - b);
          const q1 = quantile(sorted, 0.25);
          const med = quantile(sorted, 0.5);
          const q3 = quantile(sorted, 0.75);
          const min = sorted[0];
          const max = sorted[sorted.length - 1];
          const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
          const half = 22;
          return (
            <g key={g.label}>
              {/* whiskers over the full range */}
              <line x1={cx} x2={cx} y1={y(min)} y2={y(max)} stroke="var(--color-charcoal)" strokeWidth="1" />
              <line x1={cx - 8} x2={cx + 8} y1={y(min)} y2={y(min)} stroke="var(--color-charcoal)" strokeWidth="1" />
              <line x1={cx - 8} x2={cx + 8} y1={y(max)} y2={y(max)} stroke="var(--color-charcoal)" strokeWidth="1" />
              {/* interquartile box */}
              <rect
                x={cx - half}
                y={y(q3)}
                width={half * 2}
                height={Math.max(1, y(q1) - y(q3))}
                fill="var(--color-brand-soft)"
                stroke="var(--color-brand-deep)"
                strokeWidth="1"
                rx="1.5"
              />
              <line
                x1={cx - half}
                x2={cx + half}
                y1={y(med)}
                y2={y(med)}
                stroke="var(--color-charcoal)"
                strokeWidth="1.75"
              />
              {/* mean triangle */}
              <path
                d={`M ${cx - 4} ${y(mean) + 3.5} L ${cx + 4} ${y(mean) + 3.5} L ${cx} ${y(mean) - 4} Z`}
                fill="none"
                stroke="var(--color-ink)"
                strokeWidth="1.25"
              />
              {/* individual samples, nudged alternately to stay readable */}
              {g.values.map((v, vi) => (
                <circle
                  key={vi}
                  cx={cx + (vi % 2 === 0 ? -13 : 13)}
                  cy={y(v.value)}
                  r="2.4"
                  fill="var(--color-brand-deep)"
                  opacity="0.75"
                >
                  <title>{`${v.code}: ${short(v.value)}`}</title>
                </circle>
              ))}
              <text
                x={cx}
                y={TOP + PLOT_H + 13}
                textAnchor="middle"
                fontSize="9.5"
                fontWeight="bold"
                fill="var(--color-charcoal)"
                className="mono"
              >
                {g.label}
              </text>
              <text
                x={cx}
                y={TOP + PLOT_H + 24}
                textAnchor="middle"
                fontSize="8.5"
                fill="var(--color-muted)"
                className="mono"
              >
                {`x̄ ${short(mean)} · n=${sorted.length}`}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function GroupBoxPlots({
  plots,
  title,
  hint,
}: {
  plots: MetricPlot[];
  title: string;
  hint: string;
}) {
  const usable = plots.filter(
    (p) => p.groups.filter((g) => g.values.length >= 2).length >= 2,
  );
  if (!usable.length) return null;
  return (
    <section className="bg-surface border border-line rounded-[6px] p-3.5">
      <h2 className="text-[12.5px] font-bold flex items-center gap-1.5">
        <Icon name="BarChart3" size={14} className="text-charcoal" /> {title}
      </h2>
      <p className="text-[10.5px] text-muted mb-2">{hint}</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
        {usable.map((p) => (
          <BoxPlot key={p.metric} plot={p} />
        ))}
      </div>
    </section>
  );
}
