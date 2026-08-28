"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui";
import { useT } from "@/lib/i18n/LanguageProvider";
import { requestExport, buildDataCsv } from "@/lib/actions/exports";

export function DataTable({
  columns, rows, total, page, perPage, query, canExportDirectly,
}: {
  columns: string[];
  rows: Record<string, string>[];
  /** Experiments matching the search (paging is by experiment). */
  total: number;
  page: number;
  perPage: number;
  query: string;
  /** Administrators export straight away; everyone else raises a request. */
  canExportDirectly: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const [filter, setFilter] = useState(query);
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
        <h1 className="text-[14px] font-bold shrink-0" title={t("data.subtitle")}>
          {t("data.title")}
        </h1>
        <input
          className="h-8 border border-line rounded-[4px] px-3 text-[12.5px] bg-surface w-44 lg:w-64 min-w-0 shrink-0"
          placeholder={t("data.search")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && go(1, filter)}
        />
        <button
          onClick={() => go(1, filter)}
          className="h-8 shrink-0 whitespace-nowrap px-3 border border-line rounded-[4px] text-[12px] font-semibold text-charcoal hover:bg-subtle"
        >
          {t("data.searchGo")}
        </button>
        <span className="mono text-[11px] text-muted whitespace-nowrap shrink-0">
          {filtered.length} {t("data.rows")} · {columns.length} {t("data.columns")}
        </span>
        <span className="flex-1" />
        <span className="text-[11px] text-muted whitespace-nowrap shrink-0 hidden md:inline">
          {t("data.pageOf").replace("{page}", String(page)).replace("{pages}", String(pages))}
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
            onClick={() => (canExportDirectly ? exportCsv("") : setAsking(true))}
            className="h-8 shrink-0 whitespace-nowrap bg-ink text-white rounded-[4px] px-3 text-[12px] font-semibold flex items-center gap-1.5 disabled:opacity-50"
          >
            <Icon name="Download" size={13} className="shrink-0" />
            {canExportDirectly ? t("data.export") : t("exp.request")}
          </button>
        )}
      </div>
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
                      (c === "Sample ID" || c === "Experiment" || c === "Group" ? "mono font-medium" : "text-charcoal")
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
                <td colSpan={columns.length} className="px-4 py-8 text-center text-muted text-sm">
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
