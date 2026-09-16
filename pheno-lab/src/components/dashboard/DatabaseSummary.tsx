"use client";

import type { DatabaseSummary } from "@/lib/actions/insights";
import { useT } from "@/lib/i18n/LanguageProvider";

const fmt = (n: number) => n.toLocaleString();

/** Headline counts. The search lives on the data table below (one box). */
export function DatabaseSummaryBar({ summary }: { summary: DatabaseSummary }) {
  const t = useT();

  // Two numbers, by decision (Michael, 2026-09-16): data points — every
  // (x, y) point of every measurement curve — and experiments, where every
  // sample counts as one. The other totals were noise next to these.
  const tiles: [string, number, string?][] = [
    [t("sum.dataPoints"), summary.dataPoints, t("sum.dataPointsHint")],
    [t("sum.experiments"), summary.samples, t("sum.experimentsHint")],
  ];

  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-2 gap-1.5 max-w-xl">
        {tiles.map(([label, n, hint], i) => (
          <div
            key={label}
            title={hint}
            className={
              "bg-surface border rounded-[6px] px-2.5 py-2 " +
              (i === 0 ? "border-brand/50 bg-brand-soft" : "border-line")
            }
          >
            <div
              className={
                "mono font-bold leading-none " +
                (i === 0 ? "text-[17px] text-brand-deep" : "text-[15px]")
              }
            >
              {fmt(n)}
            </div>
            <div className="text-[10px] text-muted mt-1 truncate">{label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
