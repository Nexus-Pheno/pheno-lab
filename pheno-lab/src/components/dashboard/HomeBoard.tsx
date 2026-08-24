"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ExperimentStatus } from "@prisma/client";
import { updateExperimentMeta, createExperiment, duplicateExperiment, deleteExperiment } from "@/lib/actions/experiments";
import { useT } from "@/lib/i18n/LanguageProvider";
import { Icon } from "@/components/ui";
import { usePointerDrag } from "@/lib/usePointerDrag";

export type ExpRow = {
  id: string;
  code: string;
  title: string;
  status: string;
  createdBy: string;
  members: string[];
  labels: string[];
  campaign: string;
  samples: number;
  steps: number;
  characterizations: number;
  updatedAt: string;
};

const STATUSES: ExperimentStatus[] = ["DRAFT", "IN_LAB", "REVIEW", "COMPLETE", "ARCHIVED"];

const STATUS_TONE: Record<string, string> = {
  DRAFT: "bg-warn-soft text-warn border-warn-line",
  IN_LAB: "bg-brand-soft text-brand-deep border-brand/40",
  REVIEW: "bg-warn-soft text-warn border-warn-line",
  COMPLETE: "bg-subtle text-muted border-line",
  ARCHIVED: "bg-subtle text-muted border-line",
};

export function HomeBoard({ role, experiments: initial }: { role: string; experiments: ExpRow[] }) {
  const t = useT();
  const router = useRouter();
  const [experiments, setExperiments] = useState(initial);
  const [view, setView] = useState<"kanban" | "list">(() => {
    if (typeof window === "undefined") return "kanban";
    return localStorage.getItem("pheno_home_view") === "list" ? "list" : "kanban";
  });
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [newMode, setNewMode] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [confirmingCopy, setConfirmingCopy] = useState<string | null>(null);
  const canEdit = role !== "TECHNICIAN";
  const dragRef = useRef<string | null>(null);
  const [dropCol, setDropCol] = useState<string | null>(null);

  const switchView = (v: "kanban" | "list") => {
    setView(v);
    localStorage.setItem("pheno_home_view", v);
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return experiments;
    return experiments.filter((e) =>
      [e.code, e.title, e.createdBy, e.status, e.campaign, ...e.labels, ...e.members].some((v) =>
        v.toLowerCase().includes(q)
      )
    );
  }, [experiments, query]);

  const moveTo = async (status: ExperimentStatus) => {
    const id = dragRef.current;
    dragRef.current = null;
    setDropCol(null);
    if (!id) return;
    const exp = experiments.find((e) => e.id === id);
    if (!exp || exp.status === status) return;
    setExperiments((es) => es.map((e) => (e.id === id ? { ...e, status } : e)));
    await updateExperimentMeta(id, { status });
  };

  // Touch-capable kanban drag: pointer drag from the card's grip handle,
  // auto-scrolling the column strip near screen edges on phones.
  const boardRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const startCardDrag = usePointerDrag({
    attr: "data-drop-col",
    onHover: setDropCol,
    onDrop: (dragged, col) => {
      dragRef.current = dragged;
      void moveTo(col as ExperimentStatus);
    },
    scrollEls: () => [boardRef.current, mainRef.current],
  });

  const duplicate = async (id: string) => {
    setConfirmingCopy(null);
    setBusy(true);
    const created = await duplicateExperiment(id);
    // Show the copy immediately: optimistic insert from the source row, then
    // refresh to pull the server's canonical data.
    const src = experiments.find((e) => e.id === id);
    if (created && src) {
      setExperiments((es) => [
        {
          ...src,
          id: created.id,
          code: created.code,
          title: `${src.title} (copy)`,
          status: "DRAFT",
          updatedAt: new Date().toISOString().slice(0, 10),
        },
        ...es,
      ]);
    }
    setBusy(false);
    router.refresh();
  };

  const remove = async (id: string) => {
    setConfirmingDelete(null);
    setExperiments((es) => es.filter((e) => e.id !== id));
    await deleteExperiment(id);
    router.refresh();
  };

  // Shared row actions: capture, duplicate, delete-with-local-confirm.
  const RowActions = ({ e }: { e: ExpRow }) => (
    <span className="flex items-center gap-1" onClick={(ev) => ev.stopPropagation()}>
      {e.status === "IN_LAB" && (
        <Link href={`/experiments/${e.id}/capture`} title={t("dash.capture")}
          className="p-1 rounded-[3px] text-brand-deep hover:bg-brand-soft">
          <Icon name="ClipboardPen" size={14} />
        </Link>
      )}
      {canEdit && (
        confirmingCopy === e.id ? (
          <span className="flex items-center gap-1 bg-surface border border-brand/50 rounded-[4px] px-1.5 py-0.5">
            <span className="text-[10px] font-semibold text-brand-deep">{t("dash.duplicate")}?</span>
            <button onClick={() => duplicate(e.id)} disabled={busy} className="p-0.5 text-brand-deep" title={t("dash.duplicate")}>
              <Icon name="Check" size={12} />
            </button>
            <button onClick={() => setConfirmingCopy(null)} className="p-0.5 text-muted" title={t("set.deleteNo")}>
              <Icon name="X" size={12} />
            </button>
          </span>
        ) : (
          <button onClick={() => { setConfirmingCopy(e.id); setConfirmingDelete(null); }} disabled={busy} title={t("dash.duplicate")}
            className="p-1 rounded-[3px] text-muted hover:text-ink hover:bg-subtle disabled:opacity-40">
            <Icon name="Copy" size={13} />
          </button>
        )
      )}
      {canEdit && (
        confirmingDelete === e.id ? (
          <span className="flex items-center gap-1 bg-surface border border-warn-line rounded-[4px] px-1.5 py-0.5">
            <span className="text-[10px] font-semibold text-warn">{t("card.deleteQ")}</span>
            <button onClick={() => remove(e.id)} className="p-0.5 text-danger" title={t("set.deleteYes")}>
              <Icon name="Check" size={12} />
            </button>
            <button onClick={() => setConfirmingDelete(null)} className="p-0.5 text-muted" title={t("set.deleteNo")}>
              <Icon name="X" size={12} />
            </button>
          </span>
        ) : (
          <button onClick={() => setConfirmingDelete(e.id)} title={t("set.delete")}
            className="p-1 rounded-[3px] text-muted/60 hover:text-danger hover:bg-subtle">
            <Icon name="Trash2" size={13} />
          </button>
        )
      )}
    </span>
  );

  const statusChip = (status: string) => (
    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-[3px] border ${STATUS_TONE[status]}`}>
      {t(`status.${status}` as "status.DRAFT")}
    </span>
  );

  const KanbanCard = ({ e }: { e: ExpRow }) => (
    <div
      draggable={canEdit}
      onDragStart={(ev) => {
        dragRef.current = e.id;
        ev.dataTransfer.effectAllowed = "move";
      }}
      className="bg-surface border border-line rounded-[6px] p-3 hover:border-charcoal/40"
    >
      <Link href={`/experiments/${e.id}`} className="block">
        <div className="flex items-center gap-2 mb-1">
          <span className="mono text-[11px] font-bold text-brand-deep">{e.code}</span>
          <span className="ml-auto mono text-[10px] text-muted">{e.updatedAt}</span>
          {canEdit && (
            <span
              onPointerDown={startCardDrag(e.id)}
              onClick={(ev) => ev.preventDefault()}
              className="p-1.5 -m-1 cursor-grab active:cursor-grabbing [touch-action:none] text-muted/70"
              title={t("dash.dragHint")}
            >
              <Icon name="GripVertical" size={14} />
            </span>
          )}
        </div>
        <div className="text-[12.5px] font-medium leading-snug mb-2">{e.title}</div>
        <div className="flex items-center gap-3 text-[10.5px] text-muted mono">
          <span>{e.samples} {t("designer.samples")}</span>
          <span>{e.steps} {t("list.steps").toLowerCase()}</span>
          {e.campaign && (
            <span className="text-[9.5px] font-sans font-semibold px-1.5 py-0.5 rounded-[3px] bg-subtle border border-line text-charcoal truncate max-w-28">
              {e.campaign}
            </span>
          )}
        </div>
      </Link>
      <div className="flex items-center gap-1 mt-2">
        {[e.createdBy, ...e.members.filter((m) => m !== e.createdBy)].slice(0, 4).map((m) => (
          <span key={m} title={m}
            className="w-5 h-5 rounded-full bg-subtle border border-line text-[8px] font-bold text-charcoal flex items-center justify-center">
            {m.slice(0, 2).toUpperCase()}
          </span>
        ))}
        <span className="flex-1" />
        <RowActions e={e} />
      </div>
    </div>
  );

  return (
    <main ref={mainRef} className="h-full overflow-y-auto bg-subtle">
      <div className="max-w-6xl mx-auto p-3 sm:p-6">
        {/* Stable two-row header: identical in both views so the toggle
            never reshuffles the top controls. */}
        <div className="mb-4 space-y-3">
          <div>
            <h1 className="text-lg font-bold">{t(role === "TECHNICIAN" ? "dash.titleTech" : "dash.title")}</h1>
            <p className="text-xs text-muted">
              {t(role === "TECHNICIAN" ? "dash.subtitleTech" : "dash.subtitle")}
              {canEdit && view === "kanban" && ` · ${t("dash.dragHint")}`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="h-8 border border-line rounded-[4px] px-3 text-[12.5px] bg-surface w-full sm:w-56"
              placeholder={t("dash.search")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="h-8 flex border border-line rounded-[4px] overflow-hidden">
              {(["kanban", "list"] as const).map((v) => (
                <button key={v} onClick={() => switchView(v)}
                  className={"text-[12px] font-semibold px-3.5 flex items-center gap-1.5 " +
                    (view === v ? "bg-ink text-white" : "bg-surface text-charcoal hover:bg-subtle")}>
                  <Icon name={v === "kanban" ? "Columns3" : "List"} size={13} />
                  {t(v === "kanban" ? "dash.kanban" : "dash.list")}
                </button>
              ))}
            </div>
            {canEdit && (
              <>
                <span className="flex-1" />
                {/* Real or test is chosen up front — a test run never reaches
                    the real board, and the whole test space can be cleared. */}
                {newMode ? (
                  <span className="flex items-center gap-1.5 bg-surface border border-line rounded-[4px] p-1">
                    <span className="text-[11.5px] font-semibold text-muted px-1">{t("dash.newAs")}</span>
                    <button
                      disabled={busy}
                      onClick={async () => { setBusy(true); await createExperiment(false); }}
                      className="h-7 px-2.5 bg-brand text-[#243000] rounded-[4px] text-[11.5px] font-bold"
                    >
                      {t("dash.newReal")}
                    </button>
                    <button
                      disabled={busy}
                      onClick={async () => { setBusy(true); await createExperiment(true); }}
                      className="h-7 px-2.5 border border-warn-line bg-warn-soft text-warn rounded-[4px] text-[11.5px] font-bold"
                    >
                      {t("dash.newTest")}
                    </button>
                    <button onClick={() => setNewMode(false)} className="p-1 text-muted">
                      <Icon name="X" size={13} />
                    </button>
                  </span>
                ) : (
                  <button
                    onClick={() => setNewMode(true)}
                    disabled={busy}
                    className="h-8 bg-brand text-[#243000] rounded-[4px] px-4 text-[12.5px] font-bold disabled:opacity-50 flex items-center gap-1.5"
                  >
                    <Icon name="Plus" size={14} />
                    {t("dash.new")}
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        {filtered.length === 0 ? (
          <p className="text-center text-muted text-sm py-14">
            {experiments.length === 0 ? t(canEdit ? "list.emptyStaff" : "list.emptyTech") : t("data.noRows")}
          </p>
        ) : view === "kanban" ? (
          <div
            ref={boardRef}
            className="flex gap-3 overflow-x-auto no-scrollbar items-start pb-2 -mx-3 px-3 sm:mx-0 sm:px-0 lg:grid lg:grid-cols-5 lg:gap-2.5 lg:overflow-visible lg:pb-0"
          >
            {STATUSES.map((status) => {
              const items = filtered.filter((e) => e.status === status);
              return (
                <div
                  key={status}
                  data-drop-col={status}
                  onDragOver={(ev) => {
                    if (!canEdit) return;
                    ev.preventDefault();
                    setDropCol(status);
                  }}
                  onDragLeave={() => setDropCol((c) => (c === status ? null : c))}
                  onDrop={(ev) => {
                    ev.preventDefault();
                    moveTo(status);
                  }}
                  className={
                    "rounded-[6px] border p-2.5 min-h-40 w-64 shrink-0 lg:w-auto lg:shrink " +
                    (dropCol === status ? "border-brand border-dashed bg-brand-soft/40" : "border-line bg-surface/50")
                  }
                >
                  <div className="flex items-center gap-2 px-1 pb-2">
                    {statusChip(status)}
                    <span className="mono text-[11px] text-muted">{items.length}</span>
                  </div>
                  <div className="space-y-2">
                    {items.map((e) => <KanbanCard key={e.id} e={e} />)}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="bg-surface border border-line rounded-[6px] overflow-x-auto">
            <table className="w-full min-w-[760px] text-[13px]">
              <thead>
                <tr className="text-left text-[11px] uppercase text-muted border-b border-line">
                  <th className="px-4 py-2.5 font-bold">{t("list.code")}</th>
                  <th className="px-4 py-2.5 font-bold">{t("list.titleCol")}</th>
                  <th className="px-4 py-2.5 font-bold">{t("list.status")}</th>
                  <th className="px-4 py-2.5 font-bold">{t("list.createdBy")}</th>
                  <th className="px-4 py-2.5 font-bold text-right">{t("list.samples")}</th>
                  <th className="px-4 py-2.5 font-bold text-right">{t("list.steps")}</th>
                  <th className="px-4 py-2.5 font-bold">{t("list.labels")}</th>
                  <th className="px-4 py-2.5 font-bold">{t("list.updated")}</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((e) => (
                  <tr key={e.id} className="border-b border-line last:border-0 hover:bg-subtle">
                    <td className="px-4 py-3">
                      <Link href={`/experiments/${e.id}`} className="mono font-semibold text-brand-deep">{e.code}</Link>
                    </td>
                    <td className="px-4 py-3"><Link href={`/experiments/${e.id}`}>{e.title}</Link></td>
                    <td className="px-4 py-3">{statusChip(e.status)}</td>
                    <td className="px-4 py-3 text-muted">{e.createdBy}</td>
                    <td className="px-4 py-3 text-right mono">{e.samples}</td>
                    <td className="px-4 py-3 text-right mono">{e.steps}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {e.labels.slice(0, 4).map((l) => (
                          <span key={l} className="text-[10px] px-1.5 py-0.5 bg-subtle border border-line rounded-[3px] text-charcoal">{l}</span>
                        ))}
                        {e.labels.length > 4 && <span className="text-[10px] text-muted">+{e.labels.length - 4}</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted mono">{e.updatedAt}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end">
                        <RowActions e={e} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
