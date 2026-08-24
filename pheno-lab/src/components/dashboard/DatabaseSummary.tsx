"use client";

import { useState } from "react";
import Link from "next/link";
import { searchExperiments, type DatabaseSummary, type SearchHit } from "@/lib/actions/insights";
import { useT } from "@/lib/i18n/LanguageProvider";
import { Icon } from "@/components/ui";

const fmt = (n: number) => n.toLocaleString();

/** Headline counts plus a search that understands materials and processes. */
export function DatabaseSummaryBar({ summary }: { summary: DatabaseSummary }) {
  const t = useT();
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [interpreted, setInterpreted] = useState("");

  const run = async () => {
    if (!q.trim()) { setHits(null); return; }
    setBusy(true);
    try {
      const r = await searchExperiments(q);
      setHits(r.hits);
      setInterpreted(r.interpreted);
    } finally {
      setBusy(false);
    }
  };

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
            <div className={"mono font-bold leading-none " + (i === 0 ? "text-[17px] text-brand-deep" : "text-[15px]")}>
              {fmt(n)}
            </div>
            <div className="text-[10px] text-muted mt-1 truncate">{label}</div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-1.5">
        <div className="relative flex-1">
          <Icon name="Search" size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") run(); }}
            placeholder={t("sum.searchPh")}
            className="h-9 w-full border border-line rounded-[4px] pl-8 pr-2 text-[12.5px] bg-surface"
          />
        </div>
        <button
          onClick={run}
          disabled={busy || !q.trim()}
          className="h-9 px-3.5 bg-ink text-white rounded-[4px] text-[12px] font-bold disabled:opacity-40"
        >
          {busy ? t("sum.searching") : t("sum.search")}
        </button>
        {hits && (
          <button
            onClick={() => { setHits(null); setQ(""); }}
            className="h-9 px-2.5 border border-line rounded-[4px] text-[12px] font-semibold text-muted"
          >
            {t("sum.clear")}
          </button>
        )}
      </div>

      {hits && (
        <div className="bg-surface border border-line rounded-[6px] overflow-hidden">
          <div className="px-3 py-2 border-b border-line flex items-center gap-2">
            <span className="text-[12px] font-bold">
              {t("sum.found").replace("{n}", String(hits.length))}
            </span>
            <span className="text-[11px] text-muted truncate">{interpreted}</span>
          </div>
          {hits.length === 0 ? (
            <p className="text-[12px] text-muted px-3 py-4 text-center">{t("sum.none")}</p>
          ) : (
            <div className="divide-y divide-line max-h-80 overflow-y-auto">
              {hits.map((h) => (
                <Link
                  key={h.id}
                  href={`/experiments/${h.id}`}
                  className="flex items-start gap-2.5 px-3 py-2 hover:bg-subtle"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      {h.isTest && (
                        <span className="text-[9px] font-bold uppercase px-1 py-0.5 rounded-[3px] bg-warn-soft text-warn border border-warn-line">
                          {t("test.badge")}
                        </span>
                      )}
                      <span className="mono text-[11px] text-muted">{h.code}</span>
                      <span className="text-[12.5px] font-semibold truncate">{h.title}</span>
                    </div>
                    {/* Always say why it matched — an unexplained result is
                        worse than no result when searching research data. */}
                    <div className="flex flex-wrap gap-1 mt-0.5">
                      {h.reasons.map((r) => (
                        <span key={r} className="text-[9.5px] px-1 py-0.5 rounded-[3px] bg-subtle border border-line text-charcoal">
                          {r}
                        </span>
                      ))}
                    </div>
                  </div>
                  <span className="text-[10.5px] text-muted mono whitespace-nowrap mt-0.5">
                    {h.samples} {t("ing.samples")}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
