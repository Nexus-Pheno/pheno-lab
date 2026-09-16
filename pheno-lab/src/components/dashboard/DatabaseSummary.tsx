"use client";

import type { DatabaseSummary } from "@/lib/actions/insights";
import { useT } from "@/lib/i18n/LanguageProvider";

const fmt = (n: number) => n.toLocaleString();

/** Headline counts. The search lives on the data table below (one box). */
export function DatabaseSummaryBar({ summary }: { summary: DatabaseSummary }) {
  const t = useT();

  const tiles: [string, number, string?][] = [
    [t("sum.dataPoints"), summary.dataPoints, t("sum.dataPointsHint")],
    [t("sum.experiments"), summary.experiments],
    [t("sum.samples"), summary.samples],
    [t("sum.results"), summary.results],
    [t("sum.runs"), summary.runs],
    [t("sum.materials"), summary.materials],
    [t("sum.recipes"), summary.recipes],
    [t("sum.files"), summary.attachments],
  ];

  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-1.5">
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
