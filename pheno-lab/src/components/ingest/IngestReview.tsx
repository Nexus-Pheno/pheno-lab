"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { buildNameIndex, matchName } from "@/lib/name-match";
import {
  updateIngestPayload, publishIngestItem, rejectIngestItem, deleteIngestItem,
  findDuplicates, markIngestDuplicate, publishIngestItems, resolveDuplicates, getIngestPayload,
  type DuplicateCandidate, type DuplicateAction, type IngestKind, type PublishResolution, type BulkPublishResult,
} from "@/lib/actions/ingest";
import { useT } from "@/lib/i18n/LanguageProvider";
import { Icon, FieldLabel, inputCls } from "@/components/ui";
import type { TKey } from "@/lib/i18n/dict";

export type FormulaComponent = { material: string; amount: string; role?: string };

export type ExperimentStep = {
  processName: string;
  name: string;
  parameters: { name: string; unit: string; value: string }[];
  materialNames: string[];
  recipeName: string;
};

export type ExperimentSample = {
  code: string;
  metrics: Record<string, string | number>;
  files: string[];
  note: string;
};

export type IngestRow = {
  id: string;
  kind: string;
  status: string;
  title: string;
  sourceFile: string;
  confidence: string;
  reviewNote: string;
  createdAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
};

// The quality gate: staged facts are edited here and only reach the live
// library when a manager publishes them.
export function IngestReview({
  items,
  processNames,
  categories,
  materialNames = [],
}: {
  items: IngestRow[];
  processNames: string[];
  categories: { code: string; name: string }[];
  /** Live library names, used to flag what a formula would introduce. */
  materialNames?: string[];
}) {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState<IngestRow | null>(null);
  const [tab, setTab] = useState<"PENDING" | "DONE">("PENDING");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResults, setBulkResults] = useState<BulkPublishResult[] | null>(null);
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [confirmDup, setConfirmDup] = useState<DuplicateAction | null>(null);

  const [kind, setKind] = useState<string>("ALL");

  const inTab = items.filter((i) => (tab === "PENDING" ? i.status === "PENDING" : i.status !== "PENDING"));
  // Counts drive the kind chips, so a queue of 900 experiments and 300
  // materials can be approved one category at a time instead of hunting
  // through a single mixed list.
  const kindCounts = inTab.reduce<Record<string, number>>((a, i) => {
    a[i.kind] = (a[i.kind] ?? 0) + 1;
    return a;
  }, {});
  const kinds = Object.keys(kindCounts).sort((a, b) => kindCounts[b] - kindCounts[a]);
  const shown = kind === "ALL" ? inTab : inTab.filter((i) => i.kind === kind);
  const pending = shown.filter((i) => i.status === "PENDING");
  const done = items.filter((i) => i.status !== "PENDING");

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allSelected = pending.length > 0 && pending.every((i) => selected.has(i.id));
  const runBulk = async () => {
    setBulkBusy(true);
    setConfirmBulk(false);
    try {
      const results = await publishIngestItems([...selected]);
      setBulkResults(results);
      setSelected(new Set());
      router.refresh();
    } finally {
      setBulkBusy(false);
    }
  };

  // Resolve everything the last run held back as a duplicate, in one action.
  const runResolve = async (action: DuplicateAction) => {
    const heldIds = (bulkResults ?? []).filter((r) => r.outcome === "HELD").map((r) => r.id);
    if (heldIds.length === 0) return;
    setBulkBusy(true);
    setConfirmDup(null);
    try {
      const results = await resolveDuplicates(heldIds, action);
      setBulkResults(results.some((r) => r.outcome !== "PUBLISHED") ? results : null);
      setSelected(new Set());
      router.refresh();
    } finally {
      setBulkBusy(false);
    }
  };

  const kindChip = (kind: string) => (
    <span className="text-[9.5px] font-bold uppercase px-1.5 py-0.5 rounded-[3px] bg-subtle border border-line text-charcoal">
      {t(`ing.kind.${kind}` as TKey)}
    </span>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1.5">
        {(["PENDING", "DONE"] as const).map((v) => (
          <button
            key={v}
            onClick={() => setTab(v)}
            className={
              "h-8 px-3 text-[12px] font-semibold rounded-[4px] border " +
              (tab === v ? "bg-ink text-white border-ink" : "bg-surface text-charcoal border-line hover:bg-subtle")
            }
          >
            {t(v === "PENDING" ? "ing.pending" : "ing.reviewed")}
            <span className="mono ml-1.5 opacity-70">
              {v === "PENDING" ? items.filter((i) => i.status === "PENDING").length : done.length}
            </span>
          </button>
        ))}
      </div>

      {kinds.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {["ALL", ...kinds].map((k) => {
            const n = k === "ALL" ? inTab.length : kindCounts[k];
            const active = kind === k;
            return (
              <button
                key={k}
                onClick={() => { setKind(k); setSelected(new Set()); }}
                className={
                  "h-7 px-2.5 text-[11.5px] font-semibold rounded-[4px] border " +
                  (active
                    ? "bg-brand-soft text-brand-deep border-brand/50"
                    : "bg-surface text-charcoal border-line hover:bg-subtle")
                }
              >
                {k === "ALL" ? t("ing.allKinds") : t(`ing.kind.${k}` as TKey)}
                <span className="mono ml-1.5 opacity-70">{n}</span>
              </button>
            );
          })}
        </div>
      )}

      {bulkResults && (
        <div className="bg-surface border border-line rounded-[6px] p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12.5px] font-bold">
              {t("ing.bulkDone")
                .replace("{n}", String(bulkResults.filter((r) => r.outcome === "PUBLISHED").length))
                .replace("{total}", String(bulkResults.length))}
            </span>
            <button onClick={() => setBulkResults(null)} className="p-1 -m-1 text-muted hover:bg-subtle rounded-[4px]">
              <Icon name="X" size={14} />
            </button>
          </div>
          {bulkResults.filter((r) => r.outcome === "HELD").length > 0 && (
            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-2">
              <span className="text-[11.5px] text-muted flex-1 min-w-40">
                {t("ing.dupWhatNext").replace("{n}", String(bulkResults.filter((r) => r.outcome === "HELD").length))}
              </span>
              {confirmDup ? (
                <span className="flex items-center gap-2 bg-warn-soft border border-warn-line rounded-[4px] px-2.5 py-1">
                  <span className="text-[11.5px] font-semibold text-warn">
                    {t(confirmDup === "REPLACE" ? "ing.dupReplaceQ" : confirmDup === "SKIP" ? "ing.dupSkipQ" : "ing.dupDeleteQ")}
                  </span>
                  <button
                    disabled={bulkBusy}
                    onClick={() => runResolve(confirmDup)}
                    className="p-0.5 text-brand-deep"
                  >
                    <Icon name="Check" size={14} />
                  </button>
                  <button onClick={() => setConfirmDup(null)} className="p-0.5 text-muted">
                    <Icon name="X" size={14} />
                  </button>
                </span>
              ) : (
                <>
                  <button
                    disabled={bulkBusy}
                    onClick={() => setConfirmDup("REPLACE")}
                    className="h-7 px-2.5 border border-line rounded-[4px] text-[11.5px] font-semibold text-charcoal hover:bg-subtle flex items-center gap-1"
                  >
                    <Icon name="RefreshCw" size={12} /> {t("ing.dupReplace")}
                  </button>
                  <button
                    disabled={bulkBusy}
                    onClick={() => setConfirmDup("SKIP")}
                    className="h-7 px-2.5 border border-line rounded-[4px] text-[11.5px] font-semibold text-charcoal hover:bg-subtle flex items-center gap-1"
                  >
                    <Icon name="SkipForward" size={12} /> {t("ing.dupBulkSkip")}
                  </button>
                  <button
                    disabled={bulkBusy}
                    onClick={() => setConfirmDup("DELETE")}
                    className="h-7 px-2.5 border border-line rounded-[4px] text-[11.5px] font-semibold text-muted hover:text-danger hover:bg-subtle flex items-center gap-1"
                  >
                    <Icon name="Trash2" size={12} /> {t("ing.dupDelete")}
                  </button>
                </>
              )}
            </div>
          )}

          {bulkResults.filter((r) => r.outcome !== "PUBLISHED").length > 0 && (
            <div className="space-y-1">
              <p className="text-[11px] text-warn font-semibold">{t("ing.bulkHeldTitle")}</p>
              {bulkResults
                .filter((r) => r.outcome !== "PUBLISHED")
                .map((r) => (
                  <div key={r.id} className="text-[11px] flex items-start gap-1.5">
                    <Icon
                      name={r.outcome === "HELD" ? "Copy" : "AlertTriangle"}
                      size={11}
                      className={"mt-0.5 shrink-0 " + (r.outcome === "HELD" ? "text-warn" : "text-danger")}
                    />
                    <span className="font-semibold">{r.title}</span>
                    <span className="text-muted">
                      — {r.outcome === "HELD" ? `${t("ing.bulkHeldDup")} ${r.message}` : r.message}
                    </span>
                  </div>
                ))}
            </div>
          )}
        </div>
      )}

      {tab === "PENDING" && pending.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 bg-surface border border-line rounded-[6px] px-3 py-2">
          <label className="flex items-center gap-1.5 text-[12px] font-semibold cursor-pointer">
            <input
              type="checkbox"
              className="accent-[#4f6b00] w-3.5 h-3.5"
              checked={allSelected}
              onChange={() => setSelected(allSelected ? new Set() : new Set(pending.map((i) => i.id)))}
            />
            {kind === "ALL"
              ? t("ing.selectAll")
              : t("ing.selectAllKind").replace("{kind}", t(`ing.kind.${kind}` as TKey))}
          </label>
          <span className="text-[11.5px] text-muted mono">
            {t("ing.nSelected").replace("{n}", String(selected.size))}
          </span>
          <span className="flex-1" />
          {confirmBulk ? (
            <span className="flex items-center gap-2 bg-warn-soft border border-warn-line rounded-[4px] px-2.5 py-1">
              <span className="text-[11.5px] font-semibold text-warn">
                {t("ing.bulkConfirm").replace("{n}", String(selected.size))}
              </span>
              <button disabled={bulkBusy} onClick={runBulk} className="p-0.5 text-brand-deep">
                <Icon name="Check" size={14} />
              </button>
              <button onClick={() => setConfirmBulk(false)} className="p-0.5 text-muted">
                <Icon name="X" size={14} />
              </button>
            </span>
          ) : (
            <button
              disabled={selected.size === 0 || bulkBusy}
              onClick={() => setConfirmBulk(true)}
              className="h-8 px-3 bg-brand text-[#243000] rounded-[4px] text-[12px] font-bold disabled:opacity-40 flex items-center gap-1.5"
            >
              <Icon name="CheckCheck" size={14} />
              {bulkBusy ? t("ing.bulkRunning") : t("ing.bulkApprove")}
            </button>
          )}
        </div>
      )}

      {shown.length === 0 ? (
        <p className="text-[12.5px] text-muted py-6 text-center">
          {t(tab === "PENDING" ? "ing.emptyPending" : "ing.emptyDone")}
        </p>
      ) : (
        <div className="bg-surface border border-line rounded-[6px] divide-y divide-line">
          {shown.map((it) => (
            <div key={it.id} className="flex items-center gap-2.5 px-3.5 py-2.5">
              {it.status === "PENDING" && (
                <input
                  type="checkbox"
                  className="accent-[#4f6b00] w-3.5 h-3.5 shrink-0"
                  checked={selected.has(it.id)}
                  onChange={() => toggle(it.id)}
                />
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  {kindChip(it.kind)}
                  <span className="text-[12.5px] font-semibold truncate">{it.title}</span>
                </div>
                <div className="text-[10.5px] text-muted truncate mt-0.5">
                  {it.sourceFile && <span className="mono">{it.sourceFile}</span>}
                  {it.confidence && <span> · {it.confidence}</span>}
                  {it.reviewedBy && <span> · {t("ing.by")} {it.reviewedBy}</span>}
                </div>
              </div>
              {it.status === "PENDING" ? (
                <button
                  onClick={() => setOpen(it)}
                  className="h-8 px-3 text-[11.5px] font-bold text-brand-deep border border-brand/40 bg-brand-soft rounded-[4px] shrink-0"
                >
                  {t("ing.review")}
                </button>
              ) : (
                <span
                  className={
                    "text-[10px] font-semibold px-1.5 py-0.5 rounded-[3px] border shrink-0 " +
                    (it.status === "PUBLISHED"
                      ? "bg-brand-soft text-brand-deep border-brand/40"
                      : it.status === "DUPLICATE"
                        ? "bg-warn-soft text-warn border-warn-line"
                        : "bg-subtle text-muted border-line")
                  }
                >
                  {t(
                    it.status === "PUBLISHED"
                      ? "ing.published"
                      : it.status === "DUPLICATE"
                        ? "ing.dupStatus"
                        : "ing.rejected"
                  )}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {open && (
        <ReviewModal
          item={open}
          processNames={processNames}
          categories={categories}
          materialNames={materialNames}
          onClose={() => setOpen(null)}
          onDone={() => { setOpen(null); router.refresh(); }}
        />
      )}
    </div>
  );
}

function ReviewModal({
  item, processNames, categories, materialNames, onClose, onDone,
}: {
  item: IngestRow;
  processNames: string[];
  categories: { code: string; name: string }[];
  materialNames: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const [payload, setPayload] = useState<Record<string, unknown>>({});
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let dead = false;
    getIngestPayload(item.id).then((p) => {
      if (!dead) { setPayload(p); setLoaded(true); }
    });
    return () => { dead = true; };
  }, [item.id]);
  const [note, setNote] = useState(item.reviewNote);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmReject, setConfirmReject] = useState(false);
  const [dups, setDups] = useState<DuplicateCandidate[] | null>(null);
  const [updateTarget, setUpdateTarget] = useState<string | null>(null);
  const [createAnyway, setCreateAnyway] = useState(false);

  const set = (k: string, v: unknown) => setPayload((p) => ({ ...p, [k]: v }));
  const str = (k: string) => (typeof payload[k] === "string" ? (payload[k] as string) : "");

  // Re-check for duplicates whenever an identifying field changes — editing
  // the name is exactly how a reviewer resolves a false positive.
  const identity = JSON.stringify(
    ["name", "casNumber", "composition", "assetTag", "make", "model"].map((k) => str(k))
  );
  useEffect(() => {
    let cancelled = false;
    setDups(null);
    setUpdateTarget(null);
    setCreateAnyway(false);
    const timer = setTimeout(async () => {
      try {
        const found = await findDuplicates(item.kind as IngestKind, payload, item.id);
        if (!cancelled) setDups(found);
      } catch {
        if (!cancelled) setDups([]);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, item.id, item.kind]);

  const libraryDups = (dups ?? []).filter((d) => d.source === "LIBRARY");
  const queueDups = (dups ?? []).filter((d) => d.source === "QUEUE");
  // Publishing is blocked until the reviewer says what to do about a match.
  const dupUnresolved = libraryDups.length > 0 && !updateTarget && !createAnyway;

  const textField = (label: string, key: string, mono = false) => (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <input className={inputCls + (mono ? " mono" : "")} value={str(key)} onChange={(e) => set(key, e.target.value)} />
    </div>
  );

  const textArea = (label: string, key: string, rows = 3) => (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <textarea className={inputCls + " resize-none"} rows={rows} value={str(key)} onChange={(e) => set(key, e.target.value)} />
    </div>
  );

  // Free-form extras the agent extracted that have no dedicated field.
  const knownKeys =
    item.kind === "MATERIAL"
      ? ["name", "category", "composition", "smiles", "casNumber", "molecularWeight", "purity", "supplier", "lot", "properties", "notes"]
      : item.kind === "EQUIPMENT"
        ? ["name", "make", "model", "assetTag", "processName", "locationName", "parameters", "notes"]
        : item.kind === "FORMULA"
          ? ["name", "summary", "composition", "bandGap", "components", "solvents", "concentration", "procedure", "notes"]
          : item.kind === "ENVIRONMENT"
            ? ["name", "conditions", "notes"]
            : item.kind === "PRESET"
              ? ["name", "processName", "parameters", "notes"]
              : item.kind === "EXPERIMENT"
                ? ["title", "operator", "scale", "batchLabel", "date", "campaign", "hypothesis",
                   "problem", "conclusion", "observation", "steps", "characterizations",
                   "samples", "sourceFiles"]
                : [];

  const extras = Object.entries(payload).filter(([k]) => !knownKeys.includes(k));

  return (
    <div className="fixed inset-0 z-50 bg-ink/30 flex items-end sm:items-center justify-center p-0 sm:p-6" onClick={onClose}>
      <div
        className="w-full sm:max-w-xl bg-surface rounded-t-[10px] sm:rounded-[10px] border border-line max-h-[90dvh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-line">
          <div className="min-w-0">
            <div className="text-[13px] font-bold truncate">{item.title}</div>
            <div className="text-[10.5px] text-muted truncate">
              {t(`ing.kind.${item.kind}` as TKey)}
              {item.sourceFile && <span className="mono"> · {item.sourceFile}</span>}
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 -m-1 text-muted hover:bg-subtle rounded-[4px] shrink-0">
            <Icon name="X" size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {item.confidence && (
            <p className="text-[11px] text-warn bg-warn-soft border border-warn-line rounded-[4px] px-2.5 py-1.5">
              {t("ing.agentNote")}: {item.confidence}
            </p>
          )}

          {libraryDups.length > 0 && (
            <div className="border border-danger-line bg-danger-soft rounded-[6px] p-2.5 space-y-2">
              <div className="flex items-center gap-1.5">
                <Icon name="Copy" size={13} className="text-danger" />
                <span className="text-[12px] font-bold text-danger">{t("ing.dupTitle")}</span>
              </div>
              <p className="text-[11px] text-charcoal">{t("ing.dupBody")}</p>
              {libraryDups.map((d) => (
                <div key={d.id} className="bg-surface border border-line rounded-[4px] p-2 space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-[12px] font-semibold truncate">{d.name}</div>
                      <div className="text-[10px] text-muted">
                        {t("ing.dupMatchedOn")} {d.matchedOn}
                        {d.identical && <span className="text-danger font-semibold"> · {t("ing.dupIdentical")}</span>}
                      </div>
                    </div>
                    <button
                      onClick={() => { setUpdateTarget(d.id); setCreateAnyway(false); }}
                      className={
                        "h-7 px-2.5 text-[11px] font-bold rounded-[4px] border shrink-0 " +
                        (updateTarget === d.id
                          ? "bg-ink text-white border-ink"
                          : "bg-surface text-charcoal border-line hover:bg-subtle")
                      }
                    >
                      {updateTarget === d.id ? t("ing.dupWillUpdate") : t("ing.dupUpdate")}
                    </button>
                  </div>
                  {d.differences.length > 0 && (
                    <div className="border-t border-line pt-1.5 space-y-0.5">
                      {d.differences.map((f) => (
                        <div key={f.field} className="grid grid-cols-[88px_1fr_1fr] gap-1.5 text-[10.5px] items-baseline">
                          <span className="text-muted truncate">{f.field}</span>
                          <span className="mono line-through text-muted truncate">{f.existing || "—"}</span>
                          <span className="mono text-brand-deep truncate">{f.incoming}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              <div className="flex flex-wrap items-center gap-2 pt-0.5">
                <button
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    await markIngestDuplicate(item.id, note, libraryDups[0].id);
                    setBusy(false);
                    onDone();
                  }}
                  className="h-8 px-3 text-[11.5px] font-bold bg-ink text-white rounded-[4px]"
                >
                  {t("ing.dupBulkSkip")}
                </button>
                <button
                  onClick={() => { setCreateAnyway(!createAnyway); setUpdateTarget(null); }}
                  className={
                    "h-8 px-3 text-[11.5px] font-semibold rounded-[4px] border " +
                    (createAnyway ? "bg-warn-soft text-warn border-warn-line" : "bg-surface text-muted border-line")
                  }
                >
                  {createAnyway ? t("ing.dupCreatingNew") : t("ing.dupCreateNew")}
                </button>
              </div>
            </div>
          )}

          {queueDups.length > 0 && (
            <p className="text-[11px] text-warn bg-warn-soft border border-warn-line rounded-[4px] px-2.5 py-1.5">
              {t("ing.dupQueue")}: {queueDups.map((d) => d.name).join(", ")}
            </p>
          )}

          {item.kind === "MATERIAL" && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {textField(t("mat.name"), "name")}
                <div>
                  <FieldLabel>{t("mat.category")}</FieldLabel>
                  <select
                    className="h-9 w-full border border-line rounded-[4px] px-2 text-[12.5px] bg-surface"
                    value={str("category") || "OTHER"}
                    onChange={(e) => set("category", e.target.value)}
                  >
                    {categories.map((c) => (
                      <option key={c.code} value={c.code}>{c.name}</option>
                    ))}
                  </select>
                </div>
              </div>
              {textField(t("mat.formula"), "composition", true)}
              {textField(t("mat.smiles"), "smiles", true)}
              <div className="grid grid-cols-3 gap-2.5">
                {textField("CAS", "casNumber", true)}
                {textField(t("mat.mw"), "molecularWeight", true)}
                {textField(t("mat.purity"), "purity", true)}
              </div>
              <div className="grid grid-cols-2 gap-2.5">
                {textField(t("mat.vendor"), "supplier")}
                {textField(t("mat.lot"), "lot", true)}
              </div>
              <KeyValueEditor
                label={t("mat.props")}
                value={(payload.properties as Record<string, string>) ?? {}}
                onChange={(v) => set("properties", v)}
              />
            </>
          )}

          {item.kind === "EQUIPMENT" && (
            <>
              {textField(t("lib.equipmentName"), "name")}
              <div className="grid grid-cols-3 gap-2.5">
                {textField(t("lib.manufacturer"), "make")}
                {textField(t("lib.modelNumber"), "model")}
                {textField(t("lib.assetTag"), "assetTag", true)}
              </div>
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <FieldLabel>{t("ing.process")}</FieldLabel>
                  <select
                    className="h-9 w-full border border-line rounded-[4px] px-2 text-[12.5px] bg-surface"
                    value={str("processName")}
                    onChange={(e) => set("processName", e.target.value)}
                  >
                    <option value="">{t("ing.pickProcess")}</option>
                    {processNames.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>
                {textField(t("lib.location"), "locationName")}
              </div>
              <ParamListEditor
                label={t("lib.machineParams")}
                value={(payload.parameters as { name: string; unit: string; defaultValue: string }[]) ?? []}
                onChange={(v) => set("parameters", v)}
              />
            </>
          )}

          {item.kind === "FORMULA" && (
            <>
              {textField(t("rec.name"), "name")}
              <div>
                <FieldLabel>{t("rec.summary")}</FieldLabel>
                <input className={inputCls} value={str("summary")} onChange={(e) => set("summary", e.target.value)} />
                <p className="text-[10.5px] text-muted mt-1">{t("rec.summaryHint")}</p>
              </div>
              {textField(t("ing.composition"), "composition", true)}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                {textField(t("ing.bandGap"), "bandGap", true)}
                {textField(t("rec.concentration"), "concentration", true)}
                {textField(t("rec.solvents"), "solvents", true)}
              </div>
              <ComponentEditor
                value={(payload.components as FormulaComponent[]) ?? []}
                onChange={(v) => set("components", v)}
                materialNames={materialNames}
              />
              {textArea(t("rec.procedure"), "procedure", 4)}
              {textArea(t("ing.formulaNotes"), "notes", 2)}
            </>
          )}

          {item.kind === "ENVIRONMENT" && (
            <>
              {textField(t("lib.envName"), "name")}
              <ParamListEditor
                label={t("lib.conditions")}
                value={(payload.conditions as { name: string; unit: string; defaultValue: string }[]) ?? []}
                onChange={(v) => set("conditions", v)}
              />
              {textArea(t("ing.formulaNotes"), "notes", 2)}
            </>
          )}

          {item.kind === "PRESET" && (
            <>
              {textField(t("ing.presetName"), "name")}
              <div>
                <FieldLabel>{t("ing.process")}</FieldLabel>
                <select
                  className="h-9 w-full border border-line rounded-[4px] px-2 text-[12.5px] bg-surface"
                  value={str("processName")}
                  onChange={(e) => set("processName", e.target.value)}
                >
                  <option value="">{t("ing.pickProcess")}</option>
                  {processNames.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <ParamListEditor
                label={t("lib.machineParams")}
                valueKey="value"
                value={(payload.parameters as { name: string; unit: string; value: string }[]) ?? []}
                onChange={(v) => set("parameters", v)}
              />
              {textArea(t("ing.formulaNotes"), "notes", 2)}
            </>
          )}

          {item.kind === "EXPERIMENT" && (
            <>
              {textField(t("ing.expTitle"), "title")}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                {textField(t("ing.operator"), "operator")}
                {textField(t("ing.scale"), "scale")}
                {textField(t("ing.batch"), "batchLabel", true)}
                {textField(t("ing.date"), "date", true)}
              </div>
              {textArea(t("sci.hypothesis"), "hypothesis", 2)}
              {textArea(t("sci.problem"), "problem", 2)}
              {textArea(t("sci.conclusion"), "conclusion", 2)}
              <ExperimentSummary payload={payload} materialNames={materialNames} />
            </>
          )}

          {extras.length > 0 && (
            <div>
              <FieldLabel>{t("ing.extras")}</FieldLabel>
              <pre className="text-[10.5px] mono bg-subtle border border-line rounded-[4px] p-2 overflow-x-auto">
                {JSON.stringify(Object.fromEntries(extras), null, 2)}
              </pre>
            </div>
          )}

          <div>
            <FieldLabel>{t("ing.reviewNote")}</FieldLabel>
            <textarea className={inputCls + " resize-none"} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          {error && <p className="text-[12px] text-danger">{error}</p>}
        </div>

        <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-t border-line">
          {confirmReject ? (
            <span className="flex items-center gap-2 bg-warn-soft border border-warn-line rounded-[4px] px-2.5 py-1.5">
              <span className="text-[11.5px] font-semibold text-warn">{t("ing.rejectQ")}</span>
              <button
                disabled={busy}
                onClick={async () => { setBusy(true); await rejectIngestItem(item.id, note); setBusy(false); onDone(); }}
                className="p-0.5 text-danger"
              >
                <Icon name="Check" size={13} />
              </button>
              <button onClick={() => setConfirmReject(false)} className="p-0.5 text-muted">
                <Icon name="X" size={13} />
              </button>
            </span>
          ) : (
            <button onClick={() => setConfirmReject(true)} className="text-[11.5px] font-semibold text-muted hover:text-danger px-1">
              {t("ing.reject")}
            </button>
          )}
          <span className="flex-1" />
          <button
            disabled={busy}
            onClick={async () => { setBusy(true); await updateIngestPayload(item.id, payload, note); setBusy(false); onDone(); }}
            className="h-9 px-3.5 border border-line rounded-[4px] text-[12px] font-semibold text-charcoal"
          >
            {t("ing.saveDraft")}
          </button>
          <button
            disabled={busy || dupUnresolved}
            title={dupUnresolved ? t("ing.dupBlocked") : undefined}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                const resolution: PublishResolution = updateTarget
                  ? { mode: "UPDATE", targetId: updateTarget }
                  : createAnyway
                    ? { mode: "CREATE_ANYWAY" }
                    : { mode: "AUTO" };
                await publishIngestItem(item.id, payload, note, resolution);
                onDone();
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
            className="h-9 px-4 bg-brand text-[#243000] rounded-[4px] text-[12.5px] font-bold disabled:opacity-50 flex items-center gap-1.5"
          >
            <Icon name="Check" size={14} />
            {updateTarget ? t("ing.publishUpdate") : t("ing.publish")}
          </button>
        </div>
      </div>
    </div>
  );
}

function KeyValueEditor({
  label, value, onChange,
}: {
  label: string;
  value: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
}) {
  const t = useT();
  const [rows, setRows] = useState<[string, string][]>(Object.entries(value ?? {}));
  const push = (next: [string, string][]) => {
    setRows(next);
    onChange(Object.fromEntries(next.filter(([k]) => k.trim())));
  };
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <div className="space-y-1.5">
        {rows.map(([k, v], i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-1.5">
            <input className={inputCls} value={k} onChange={(e) => push(rows.map((x, j) => (j === i ? [e.target.value, x[1]] : x)))} />
            <input className={inputCls + " mono"} value={v} onChange={(e) => push(rows.map((x, j) => (j === i ? [x[0], e.target.value] : x)))} />
            <button onClick={() => push(rows.filter((_, j) => j !== i))} className="p-1.5 text-muted hover:text-danger">
              <Icon name="X" size={13} />
            </button>
          </div>
        ))}
        <button onClick={() => push([...rows, ["", ""]])} className="text-[11px] font-semibold text-brand-deep flex items-center gap-1">
          <Icon name="Plus" size={11} /> {t("mat.addProp")}
        </button>
      </div>
    </div>
  );
}

// A staged experiment is far too big to edit field-by-field, so the reviewer
// gets a readable summary of what publishing would create: the process steps
// in order, the samples and their metrics, and how many raw files come along.
function ExperimentSummary({
  payload, materialNames,
}: {
  payload: Record<string, unknown>;
  materialNames: string[];
}) {
  const t = useT();
  const index = useMemo(() => buildNameIndex(materialNames.map((name) => ({ name }))), [materialNames]);
  const steps = (payload.steps as ExperimentStep[]) ?? [];
  const chars = (payload.characterizations as { processName: string; name: string }[]) ?? [];
  const samples = (payload.samples as ExperimentSample[]) ?? [];
  const files = samples.reduce((n, s) => n + (s.files?.length ?? 0), 0);
  const withMetrics = samples.filter((s) => Object.keys(s.metrics ?? {}).length > 0).length;

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap gap-1.5">
        {[
          [t("ing.steps"), steps.length],
          [t("ing.characterizations"), chars.length],
          [t("ing.samples"), samples.length],
          [t("ing.withMetrics"), withMetrics],
          [t("ing.rawFiles"), files],
        ].map(([label, n]) => (
          <span key={String(label)} className="text-[10.5px] bg-subtle border border-line rounded-[3px] px-1.5 py-0.5">
            {label} <span className="mono font-bold">{n}</span>
          </span>
        ))}
      </div>

      {steps.length > 0 && (
        <div>
          <FieldLabel>{t("ing.steps")}</FieldLabel>
          <div className="border border-line rounded-[4px] divide-y divide-line">
            {steps.map((s, i) => (
              <div key={i} className="px-2 py-1.5">
                <div className="text-[11.5px] font-semibold">
                  <span className="mono text-muted mr-1.5">{i + 1}</span>
                  {s.name}
                  <span className="text-muted font-normal"> · {s.processName}</span>
                </div>
                {(s.parameters ?? []).length > 0 && (
                  <div className="text-[10px] text-muted mono truncate">
                    {(s.parameters ?? []).map((p) => `${p.name} ${p.value}${p.unit}`).join(" · ")}
                  </div>
                )}
                {(s.materialNames ?? []).length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-0.5">
                    {(s.materialNames ?? []).map((m) => {
                      const ok = !!matchName(m, index);
                      return (
                        <span
                          key={m}
                          className={
                            "text-[9.5px] px-1 py-0.5 rounded-[3px] border " +
                            (ok
                              ? "bg-brand-soft text-brand-deep border-brand/40"
                              : "bg-warn-soft text-warn border-warn-line")
                          }
                        >
                          {m}
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {samples.length > 0 && (
        <div>
          <FieldLabel>{t("ing.samples")}</FieldLabel>
          <div className="border border-line rounded-[4px] max-h-52 overflow-y-auto">
            <table className="w-full text-[10.5px]">
              <tbody className="divide-y divide-line">
                {samples.slice(0, 60).map((s, i) => (
                  <tr key={i}>
                    <td className="px-2 py-1 mono font-semibold whitespace-nowrap">{s.code}</td>
                    <td className="px-2 py-1 mono text-muted">
                      {Object.entries(s.metrics ?? {})
                        .slice(0, 6)
                        .map(([k, v]) => `${k} ${typeof v === "number" ? v.toFixed(2) : v}`)
                        .join("  ")}
                    </td>
                    <td className="px-2 py-1 text-right text-muted whitespace-nowrap">
                      {(s.files?.length ?? 0) > 0 ? `${s.files.length} file(s)` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {samples.length > 60 && (
            <p className="text-[10px] text-muted mt-1">{t("ing.andMore").replace("{n}", String(samples.length - 60))}</p>
          )}
        </div>
      )}
    </div>
  );
}

// Formula components, cross-checked against the materials library so the
// reviewer can see at a glance what a formula would introduce. Publishing a
// formula never creates materials — an unknown component is a flag, not an
// error, and is staged separately as a MATERIAL item if it should exist.
function ComponentEditor({
  value, onChange, materialNames,
}: {
  value: FormulaComponent[];
  onChange: (v: FormulaComponent[]) => void;
  materialNames: string[];
}) {
  const t = useT();
  const rows = value ?? [];
  const index = useMemo(
    () => buildNameIndex(materialNames.map((name) => ({ name }))),
    [materialNames]
  );
  const named = rows.filter((r) => r.material?.trim());
  const unknownCount = named.filter((r) => !matchName(r.material, index)).length;
  const patch = (i: number, next: Partial<FormulaComponent>) =>
    onChange(rows.map((x, j) => (j === i ? { ...x, ...next } : x)));

  return (
    <div>
      <FieldLabel>{t("rec.components")}</FieldLabel>
      <div className="space-y-1.5">
        <div className="grid grid-cols-[1fr_88px_96px_auto] gap-1.5 px-0.5">
          <span className="text-[9.5px] font-bold uppercase tracking-wide text-muted">{t("rec.component")}</span>
          <span className="text-[9.5px] font-bold uppercase tracking-wide text-muted">{t("rec.amount")}</span>
          <span className="text-[9.5px] font-bold uppercase tracking-wide text-muted">{t("ing.role")}</span>
          <span className="w-[22px]" />
        </div>
        {rows.map((r, i) => {
          const filled = !!r.material?.trim();
          const hit = filled ? matchName(r.material, index)?.name ?? null : null;
          const ok = !!hit;
          return (
            <div key={i}>
              <div className="grid grid-cols-[1fr_88px_96px_auto] gap-1.5">
                <input className={inputCls} value={r.material ?? ""} onChange={(e) => patch(i, { material: e.target.value })} />
                <input className={inputCls + " mono"} value={r.amount ?? ""} onChange={(e) => patch(i, { amount: e.target.value })} />
                <input className={inputCls} value={r.role ?? ""} onChange={(e) => patch(i, { role: e.target.value })} />
                <button onClick={() => onChange(rows.filter((_, j) => j !== i))} className="p-1.5 text-muted hover:text-danger">
                  <Icon name="X" size={13} />
                </button>
              </div>
              {filled && (
                <span
                  className={
                    "inline-flex items-center gap-1 mt-1 ml-0.5 text-[9.5px] font-semibold px-1.5 py-0.5 rounded-[3px] border " +
                    (ok
                      ? "bg-brand-soft text-brand-deep border-brand/40"
                      : "bg-warn-soft text-warn border-warn-line")
                  }
                >
                  <Icon name={ok ? "Check" : "AlertTriangle"} size={9} />
                  {!ok
                    ? t("ing.notInLibrary")
                    : hit === r.material.trim()
                      ? t("ing.inLibrary")
                      : `${t("ing.matches")} ${hit}`}
                </span>
              )}
            </div>
          );
        })}
        <button
          onClick={() => onChange([...rows, { material: "", amount: "", role: "" }])}
          className="text-[11px] font-semibold text-brand-deep flex items-center gap-1"
        >
          <Icon name="Plus" size={11} /> {t("rec.addComponent")}
        </button>
        {named.length > 0 && (
          <p className="text-[10.5px] text-muted pt-0.5">
            {unknownCount === 0
              ? t("ing.allKnown")
              : `${unknownCount}/${named.length} ${t("ing.unknownCount")}`}
          </p>
        )}
      </div>
    </div>
  );
}

// Name / unit / value rows. `valueKey` differs by target: equipment and
// environments store "defaultValue", preset parameters store "value".
function ParamListEditor<K extends string>({
  label, value, onChange, valueKey = "defaultValue" as K,
}: {
  label: string;
  value: ({ name: string; unit: string } & Record<K, string>)[];
  onChange: (v: ({ name: string; unit: string } & Record<K, string>)[]) => void;
  valueKey?: K;
}) {
  const t = useT();
  const rows = value ?? [];
  const patch = (i: number, next: Record<string, string>) =>
    onChange(rows.map((x, j) => (j === i ? { ...x, ...next } : x)));
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <div className="space-y-1.5">
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-[1fr_80px_100px_auto] gap-1.5">
            <input className={inputCls} value={r.name} onChange={(e) => patch(i, { name: e.target.value })} />
            <input className={inputCls} value={r.unit} onChange={(e) => patch(i, { unit: e.target.value })} />
            <input
              className={inputCls + " mono"}
              value={(r as Record<string, string>)[valueKey] ?? ""}
              onChange={(e) => patch(i, { [valueKey]: e.target.value })}
            />
            <button onClick={() => onChange(rows.filter((_, j) => j !== i))} className="p-1.5 text-muted hover:text-danger">
              <Icon name="X" size={13} />
            </button>
          </div>
        ))}
        <button
          onClick={() =>
            onChange([
              ...rows,
              { name: "", unit: "", [valueKey]: "" } as { name: string; unit: string } & Record<K, string>,
            ])
          }
          className="text-[11px] font-semibold text-brand-deep flex items-center gap-1"
        >
          <Icon name="Plus" size={11} /> {t("insp.addParameter")}
        </button>
      </div>
    </div>
  );
}
