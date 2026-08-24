"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { decideExportRequest, type ExportRow } from "@/lib/actions/exports";
import { useT } from "@/lib/i18n/LanguageProvider";
import { Icon } from "@/components/ui";

export function ExportLog({ rows, isAdmin }: { rows: ExportRow[]; isAdmin: boolean }) {
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState<Record<string, string>>({});

  const pending = rows.filter((r) => r.status === "PENDING");
  const history = rows.filter((r) => r.status !== "PENDING");

  const decide = async (id: string, approve: boolean) => {
    setBusy(id);
    try {
      await decideExportRequest(id, approve, note[id] ?? "");
      router.refresh();
    } finally {
      setBusy("");
    }
  };

  const badge = (s: string) =>
    s === "APPROVED"
      ? "bg-brand-soft text-brand-deep border-brand/40"
      : s === "DENIED"
        ? "bg-danger-soft text-danger border-danger-line"
        : "bg-warn-soft text-warn border-warn-line";

  const Row = ({ r, actions }: { r: ExportRow; actions: boolean }) => (
    <div className="px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className={"text-[9.5px] font-bold uppercase px-1.5 py-0.5 rounded-[3px] border " + badge(r.status)}>
          {t(`exp.status.${r.status}` as never)}
        </span>
        <span className="text-[12.5px] font-semibold">{r.scope}</span>
        <span className="mono text-[11px] text-muted">{r.rowCount} {t("data.rows")}</span>
        <span className="flex-1" />
        <span className="text-[11px] text-muted mono">{r.requestedBy} · {r.createdAt}</span>
      </div>
      {r.reason && <p className="text-[11.5px] text-charcoal mt-1">“{r.reason}”</p>}
      <p className="text-[10px] text-muted mono mt-0.5 truncate">{r.detail}</p>
      {r.status !== "PENDING" && (
        <p className="text-[10.5px] text-muted mt-0.5">
          {r.decidedBy ? `${t("exp.decidedBy")} ${r.decidedBy} · ${r.decidedAt}` : ""}
          {r.decisionNote ? ` — ${r.decisionNote}` : ""}
          {r.downloadCount > 0 ? ` · ${t("exp.downloaded")} ${r.downloadedAt} (${r.downloadCount}×)` : ""}
        </p>
      )}
      {actions && isAdmin && (
        <div className="flex flex-wrap items-center gap-1.5 mt-2">
          <input
            value={note[r.id] ?? ""}
            onChange={(e) => setNote({ ...note, [r.id]: e.target.value })}
            placeholder={t("exp.notePh")}
            className="h-7 flex-1 min-w-40 border border-line rounded-[4px] px-2 text-[11.5px] bg-surface"
          />
          <button
            disabled={busy === r.id}
            onClick={() => decide(r.id, true)}
            className="h-7 px-2.5 bg-brand text-[#243000] rounded-[4px] text-[11.5px] font-bold"
          >
            {t("exp.approve")}
          </button>
          <button
            disabled={busy === r.id}
            onClick={() => decide(r.id, false)}
            className="h-7 px-2.5 border border-danger-line text-danger bg-danger-soft rounded-[4px] text-[11.5px] font-bold"
          >
            {t("exp.deny")}
          </button>
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      {isAdmin && (
        <div>
          <h2 className="text-[12.5px] font-bold mb-1.5 flex items-center gap-1.5">
            <Icon name="Clock" size={13} className="text-warn" />
            {t("exp.pending")} <span className="mono opacity-70">{pending.length}</span>
          </h2>
          {pending.length === 0 ? (
            <p className="text-[12px] text-muted py-3 text-center bg-surface border border-line rounded-[6px]">
              {t("exp.noPending")}
            </p>
          ) : (
            <div className="bg-surface border border-line rounded-[6px] divide-y divide-line">
              {pending.map((r) => <Row key={r.id} r={r} actions />)}
            </div>
          )}
        </div>
      )}

      <div>
        <h2 className="text-[12.5px] font-bold mb-1.5">
          {t("exp.history")} <span className="mono opacity-70">{history.length}</span>
        </h2>
        {history.length === 0 ? (
          <p className="text-[12px] text-muted py-3 text-center bg-surface border border-line rounded-[6px]">
            {t("exp.noHistory")}
          </p>
        ) : (
          <div className="bg-surface border border-line rounded-[6px] divide-y divide-line">
            {history.map((r) => <Row key={r.id} r={r} actions={false} />)}
          </div>
        )}
      </div>
    </div>
  );
}
