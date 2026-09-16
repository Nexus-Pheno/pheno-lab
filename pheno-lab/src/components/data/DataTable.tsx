"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui";
import { useT } from "@/lib/i18n/LanguageProvider";
import { requestExport, buildDataCsv } from "@/lib/actions/exports";
import type { SearchHit } from "@/lib/actions/insights";

export function DataTable({
  columns,
  rows,
  total,
  page,
  perPage,
  query,
  hits,
  interpreted,
  canExportDirectly,
}: {
  columns: string[];
  rows: Record<string, string>[];
  /** Experiments matching the search (paging is by experiment). */
  total: number;
  page: number;
  perPage: number;
  query: string;
  /** The ranked experiments behind the current query, with why each matched. */
  hits: SearchHit[] | null;
  interpreted: string;
  /** Administrators export straight away; everyone else raises a request. */
  canExportDirectly: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const [filter, setFilter] = useState(query);
  const [showHits, setShowHits] = useState(false);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const filtered = rows;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const go = (next: number, q = query) => {
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim());
    if (next > 1) params.set("page", String(next));
    router.push(`/data${params.toString() ? `?${params}` : ""}`);
  };

  const writeCsv = async () => {
    // The page holds one slice of rows; the file is built server-side so the
    // download covers everything the search matches.
    const { csv } = await buildDataCsv(query);
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "pheno-lab-data.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // Every export goes through the server first: an administrator's is logged
  // and allowed, anyone else's becomes a request for approval. The file is
  // only written once the server says yes.
  const exportCsv = async (why: string) => {
    setBusy(true);
    try {
      const d = await requestExport({
        scope: "Data table",
        detail: `${columns.length} columns: ${columns.slice(0, 12).join(", ")}`,
        rowCount: total,
        reason: why,
      });
      if (d.outcome === "ALLOWED") {
        await writeCsv();
        setNotice(t("exp.logged"));
      } else if (d.outcome === "REQUESTED") {
        setNotice(t("exp.requested"));
      } else if (d.outcome === "PENDING") {
        setNotice(t("exp.alreadyPending"));
      } else {
        setNotice(t("exp.denied"));
      }
      setAsking(false);
      setReason("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="h-full flex flex-col bg-subtle">
      {/* One header line: title, search, counts, paging and export together —
          the old two-band layout ate vertical space the table needed. */}
      <div className="shrink-0 flex items-center gap-2 px-5 py-2.5 overflow-x-auto no-scrollbar whitespace-nowrap">
        <h1
          className="text-[14px] font-bold shrink-0"
          title={t("data.subtitle")}
        >
          {t("data.title")}
        </h1>
        <div className="relative w-56 lg:w-96 min-w-0 shrink-0">
          <Icon
            name="Search"
            size={13}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
          />
          <input
            className="h-8 w-full border border-line rounded-[4px] pl-7 pr-2 text-[12.5px] bg-surface"
            placeholder={t("data.search")}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && go(1, filter)}
          />
        </div>
        <button
          onClick={() => go(1, filter)}
          className="h-8 shrink-0 whitespace-nowrap px-3 bg-ink text-white rounded-[4px] text-[12px] font-bold"
        >
          {t("data.searchGo")}
        </button>
        {query && (
          <button
            onClick={() => {
              setFilter("");
              go(1, "");
            }}
            className="h-8 shrink-0 px-2.5 border border-line rounded-[4px] text-[12px] font-semibold text-muted hover:bg-subtle"
          >
            {t("sum.clear")}
          </button>
        )}
        <span className="mono text-[11px] text-muted whitespace-nowrap shrink-0">
          {filtered.length} {t("data.rows")} · {columns.length}{" "}
          {t("data.columns")}
        </span>
        <span className="flex-1" />
        <span className="text-[11px] text-muted whitespace-nowrap shrink-0 hidden md:inline">
          {t("data.pageOf")
            .replace("{page}", String(page))
            .replace("{pages}", String(pages))}
          {" · "}
          {t("data.expMatching").replace("{n}", String(total))}
        </span>
        <button
          disabled={page <= 1}
          onClick={() => go(page - 1)}
          className="h-8 px-2 border border-line rounded-[4px] text-[11.5px] font-semibold text-charcoal disabled:opacity-40 hover:bg-subtle flex items-center shrink-0"
          title={t("cap.prev")}
        >
          <Icon name="ChevronLeft" size={13} />
        </button>
        <button
          disabled={page >= pages}
          onClick={() => go(page + 1)}
          className="h-8 px-2 border border-line rounded-[4px] text-[11.5px] font-semibold text-charcoal disabled:opacity-40 hover:bg-subtle flex items-center shrink-0"
          title={t("cap.next")}
        >
          <Icon name="ChevronRight" size={13} />
        </button>
        {asking ? (
          <span className="flex items-center gap-1.5 bg-surface border border-line rounded-[4px] p-1">
            <input
              autoFocus
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t("exp.reasonPh")}
              className="h-7 w-56 border border-line rounded-[4px] px-2 text-[11.5px]"
            />
            <button
              disabled={busy || !reason.trim()}
              onClick={() => exportCsv(reason)}
              className="h-7 px-2.5 bg-ink text-white rounded-[4px] text-[11.5px] font-bold disabled:opacity-40"
            >
              {t("exp.send")}
            </button>
            <button onClick={() => setAsking(false)} className="p-1 text-muted">
              <Icon name="X" size={13} />
            </button>
          </span>
        ) : (
          <button
            disabled={busy}
            onClick={() =>
              canExportDirectly ? exportCsv("") : setAsking(true)
            }
            className="h-8 shrink-0 whitespace-nowrap bg-ink text-white rounded-[4px] px-3 text-[12px] font-semibold flex items-center gap-1.5 disabled:opacity-50"
          >
            <Icon name="Download" size={13} className="shrink-0" />
            {canExportDirectly ? t("data.export") : t("exp.request")}
          </button>
        )}
      </div>
      {hits && (
        <div className="shrink-0 px-5 pb-2">
          <div className="bg-surface border border-line rounded-[6px] overflow-hidden">
            <button
              onClick={() => setShowHits((v) => !v)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-subtle"
            >
              <span className="text-[12px] font-bold whitespace-nowrap">
                {t("sum.found").replace("{n}", String(hits.length))}
              </span>
              <span className="text-[11px] text-muted truncate flex-1">
                {interpreted}
              </span>
              {hits.length > 0 && (
                <span className="text-[11px] font-semibold text-brand-deep whitespace-nowrap flex items-center gap-1">
                  {t(showHits ? "data.hideMatches" : "data.showMatches")}
                  <Icon
                    name={showHits ? "ChevronUp" : "ChevronDown"}
                    size={12}
                  />
                </span>
              )}
            </button>
            {showHits && hits.length > 0 && (
              <div className="divide-y divide-line max-h-72 overflow-y-auto border-t border-line">
                {hits.map((h) => (
                  <Link
                    key={h.id}
                    href={`/experiments/${h.id}`}
                    className="flex items-start gap-2.5 px-3 py-1.5 hover:bg-subtle"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 min-w-0">
                        {h.isTest && (
                          <span className="text-[9px] font-bold uppercase px-1 py-0.5 rounded-[3px] bg-warn-soft text-warn border border-warn-line">
                            {t("test.badge")}
                          </span>
                        )}
                        <span className="mono text-[11px] text-muted whitespace-nowrap">
                          {h.code}
                        </span>
                        <span className="text-[12.5px] font-semibold truncate">
                          {h.title}
                        </span>
                        {/* Whose experiment this is — the first thing the
                            lab asks of a result. */}
                        <span className="text-[10.5px] text-charcoal whitespace-nowrap px-1.5 py-px rounded-full bg-subtle border border-line">
                          {h.createdBy}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-1 mt-0.5">
                        {h.reasons.map((r) => (
                          <span
                            key={r}
                            className="text-[9.5px] px-1 py-0.5 rounded-[3px] bg-subtle border border-line text-charcoal"
                          >
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
        </div>
      )}
      {notice && (
        <div className="shrink-0 px-5 pb-2">
          <p className="text-[11.5px] text-brand-deep bg-brand-soft border border-brand/40 rounded-[4px] px-2.5 py-1.5">
            {notice}
          </p>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-auto mx-5 mb-5 bg-surface border border-line rounded-[6px]">
        <table className="text-[11.5px] border-collapse min-w-full">
          <thead className="sticky top-0 z-10">
            <tr>
              {columns.map((c) => (
                <th
                  key={c}
                  className="text-left font-bold text-[10px] uppercase text-muted bg-subtle border-b border-r border-line px-2.5 py-2 whitespace-nowrap"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => (
              <tr key={i} className="hover:bg-subtle/60">
                {columns.map((c) => (
                  <td
                    key={c}
                    className={
                      "border-b border-r border-line px-2.5 py-1.5 whitespace-nowrap max-w-64 overflow-hidden text-ellipsis " +
                      (c === "Sample ID" || c === "Experiment" || c === "Group"
                        ? "mono font-medium"
                        : "text-charcoal")
                    }
                    title={r[c]}
                  >
                    {r[c] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td
                  colSpan={columns.length}
                  className="px-4 py-8 text-center text-muted text-sm"
                >
                  {t("data.noRows")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
