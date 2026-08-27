"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ExperimentFull, StepFull, SampleRow } from "@/lib/types";
import { saveExecutionBatch, saveCharResult, createNewRun, deleteExecutionPhoto, addExecutionPhotos, clearExecutions, setJvDisplayPolicy } from "@/lib/actions/runs";
import { submitForReview } from "@/lib/actions/workflow";
import { regroupSample } from "@/lib/actions/runs";
import { SubstrateBoard } from "@/components/designer/SubstrateBoard";
import type { TKey } from "@/lib/i18n/dict";
import { useT, useTerm } from "@/lib/i18n/LanguageProvider";
import { Icon, FieldLabel, inputCls } from "@/components/ui";

type Execution = {
  stepId: string;
  sampleId: string;
  actuals: Record<string, string>;
  environmentConditions: Record<string, string>;
  note: string;
  flagged: boolean;
  capturedAt: string;
  photos: { id: string; path: string }[];
};

type PhotoRef = { id?: string; path: string };

type CharResult = {
  id?: string;
  characterizationId: string;
  sampleId: string;
  metrics: Record<string, string>;
  note: string;
  source?: string;
  metricPolicy?: string;
};

// Default metric suggestions per characterization process name.
const METRIC_HINTS: [RegExp, string[]][] = [
  [/j-?v|solar/i, ["PCE (%)", "Voc (V)", "Jsc (mA/cm²)", "FF (%)"]],
  [/eqe/i, ["Integrated Jsc (mA/cm²)", "Peak EQE (%)"]],
  [/ellips|profil/i, ["Thickness (nm)"]],
  [/sem/i, ["Grain size (nm)", "Film thickness (nm)"]],
  [/xrd/i, ["Peak position (°)", "FWHM (°)"]],
  [/photolum|pl/i, ["Peak wavelength (nm)", "PLQY (%)"]],
];

const metricDefaults = (name: string): Record<string, string> => {
  const hit = METRIC_HINTS.find(([re]) => re.test(name));
  return Object.fromEntries((hit?.[1] ?? []).map((m) => [m, ""]));
};

// Planned values for a step given a variation group (null = base values).
const plannedFor = (step: StepFull, group: string | null): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const p of step.parameters) {
    const v = group ? p.variations.find((x) => x.variationGroup === group) : undefined;
    out[p.name] = v?.value ?? p.value;
  }
  return out;
};

export function CaptureView({
  exp,
  backHref,
  layers,
  runId,
  runNo,
  runs,
  initialExecutions,
  initialResults,
}: {
  exp: ExperimentFull;
  layers: { code: string; name: string }[];
  backHref: string;
  runId: string;
  runNo: number;
  runs: { id: string; runNo: number }[];
  initialExecutions: Execution[];
  initialResults: CharResult[];
}) {
  const t = useT();
  const router = useRouter();
  void runNo;
  const [executions, setExecutions] = useState<Execution[]>(initialExecutions);
  const [results, setResults] = useState<CharResult[]>(initialResults);
  const [slide, setSlide] = useState(0);
  const trackRef = useRef<HTMLDivElement>(null);

  // Capture owns the whole screen: hide the app chrome header while mounted.
  useEffect(() => {
    const header = document.getElementById("app-header");
    header?.classList.add("hidden");
    return () => header?.classList.remove("hidden");
  }, []);

  const orderedSteps = useMemo(() => [...exp.steps].sort((a, b) => a.position - b.position), [exp.steps]);
  const orderedChars = useMemo(
    () => [...exp.characterizations].sort((a, b) => a.position - b.position),
    [exp.characterizations]
  );
  const groups = useMemo(
    () => [...new Set(exp.samples.map((s) => s.variationGroup).filter(Boolean))].sort() as string[],
    [exp.samples]
  );
  const slideCount = orderedSteps.length + orderedChars.length;

  // Substrate regrouping: membership mirrors sample.variationGroup, updated
  // optimistically while the server action persists the swap.
  const plan = (exp.metadata as { testPlan?: { groups?: { label: string }[] } } | null)?.testPlan;
  const planGroups = plan?.groups?.map((g) => g.label) ?? groups;
  const [showRegroup, setShowRegroup] = useState(false);
  const [assignments, setAssignments] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      exp.samples.map((s) => [
        s.code,
        s.variationGroup === "ERROR" ? "ERROR" : (s.variationGroup ?? "EXTRA"),
      ]),
    ),
  );
  const moveSubstrate = async (code: string, zone: string) => {
    const sample = exp.samples.find((s) => s.code === code);
    if (!sample) return;
    // Trashing a substrate records why; photos can be added on the step card.
    let note: string | undefined;
    if (zone === "ERROR") {
      const answer = prompt(t("cap.trashWhy"), "");
      if (answer === null) return;
      note = answer;
    }
    setAssignments((a) => ({ ...a, [code]: zone }));
    try {
      await regroupSample(sample.id, zone, note);
      router.refresh();
    } catch {
      setAssignments((a) => ({ ...a, [code]: sample.variationGroup ?? "EXTRA" }));
    }
  };

  const execsFor = (stepId: string) => executions.filter((x) => x.stepId === stepId);
  const resultsFor = (charId: string) =>
    results.filter((r) => r.characterizationId === charId && Object.values(r.metrics).some((v) => v !== ""));

  const totalDone = executions.length;
  const totalNeeded = exp.steps.length * exp.samples.length;

  // Everything still open in this run, processing + characterization —
  // shown as a warning on the Complete card when finishing early.
  const charDone = new Set(
    results
      .filter((r) => Object.values(r.metrics).some((v) => v !== ""))
      .map((r) => r.characterizationId + "|" + r.sampleId)
  ).size;
  const missingTotal =
    (totalNeeded - totalDone) + (orderedChars.length * exp.samples.length - charDone);

  const jumpTo = useCallback((i: number) => {
    const el = trackRef.current;
    if (!el) return;
    const clamped = Math.max(0, Math.min(slideCount - 1, i));
    el.scrollTo({ left: clamped * el.clientWidth, behavior: "smooth" });
    setSlide(clamped);
  }, [slideCount]);

  // Survive pull-to-refresh: remember the current card and restore it on load.
  const slideKey = `pheno_cap_slide_${exp.id}_${runId}`;
  useEffect(() => {
    const saved = Number(sessionStorage.getItem(slideKey));
    const el = trackRef.current;
    if (!el || !Number.isFinite(saved) || saved <= 0) return;
    const clamped = Math.min(slideCount - 1, saved);
    el.scrollTo({ left: clamped * el.clientWidth });
    setSlide(clamped);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    sessionStorage.setItem(slideKey, String(slide));
  }, [slide, slideKey]);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        setSlide(Math.round(el.scrollLeft / Math.max(1, el.clientWidth)));
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);

  const advance = () => jumpTo(slide + 1);

  return (
    <main className="h-full flex flex-col bg-subtle">
      {/* Compact header */}
      <div className="shrink-0 bg-surface border-b border-line px-3 pt-2.5 pb-2 space-y-2">
        <div className="flex items-center gap-2 whitespace-nowrap">
          <Link href="/portal" title={t("portal.title")} className="shrink-0 -my-1 py-1 pr-1">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/pheno-icon.png" alt="Pheno" className="w-6 h-6" />
          </Link>
          <span className="mono text-[12.5px] font-bold truncate min-w-0 flex-1">{exp.code}</span>
          <span className="hidden sm:inline text-[11px] text-muted shrink-0">{t("cap.title")}</span>
          <span className="mono text-[10.5px] text-muted shrink-0">{totalDone}/{totalNeeded}</span>
          <Link href={`/experiments/${exp.id}/results`} className="text-[11px] font-semibold text-charcoal shrink-0 py-1 px-1">
            {t("res.title")}
          </Link>
          <Link href={backHref} className="text-[11px] font-semibold text-brand-deep shrink-0 py-1 px-1">
            {t("nav.back")}
          </Link>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex-1 h-1 bg-subtle rounded-full overflow-hidden">
            <div className="h-full bg-brand rounded-full transition-all" style={{ width: `${totalNeeded ? (totalDone / totalNeeded) * 100 : 0}%` }} />
          </div>
        </div>

        {/* Step dot navigation — run selector, then steps, then characterization */}
        <div className="no-scrollbar flex items-center gap-1 overflow-x-auto -mx-3 px-3">
          <select
            className="shrink-0 h-9 border border-line rounded-full px-2 text-[11px] bg-surface mono max-w-24"
            value={runId}
            title={t("cap.newRunHint")}
            onChange={async (e) => {
              if (e.target.value === "__new__") {
                const r = await createNewRun(exp.id);
                router.push(`/experiments/${exp.id}/capture?run=${r.id}`);
                return;
              }
              router.push(`/experiments/${exp.id}/capture?run=${e.target.value}`);
            }}
          >
            {runs.map((r) => (
              <option key={r.id} value={r.id}>{t("cap.run")} {r.runNo}</option>
            ))}
            <option value="__new__">＋ {t("cap.newRun")}</option>
          </select>
          <span className="shrink-0 w-px h-5 bg-line mx-0.5" />
          {orderedSteps.map((st, i) => {
            const captured = execsFor(st.id).length;
            const full = captured === exp.samples.length && exp.samples.length > 0;
            const flagged = execsFor(st.id).some((x) => x.flagged);
            return (
              <button
                key={st.id}
                onClick={() => jumpTo(i)}
                title={st.name}
                className={
                  "shrink-0 w-10 h-10 rounded-full font-bold border flex flex-col items-center justify-center leading-none gap-0.5 " +
                  (i === slide
                    ? "bg-ink text-white border-ink"
                    : flagged
                      ? "bg-warn-soft text-warn border-warn-line"
                      : full
                        ? "bg-brand-soft text-brand-deep border-brand/40"
                        : captured > 0
                          ? "bg-surface text-brand-deep border-brand/50"
                          : "bg-surface text-muted border-line")
                }
              >
                <Icon name={st.process.icon} size={13} />
                <span className="text-[8.5px]">{full && i !== slide ? "✓" : i + 1}</span>
              </button>
            );
          })}
          {orderedChars.length > 0 && <span className="shrink-0 w-px h-5 bg-line mx-1" />}
          {orderedChars.map((c, j) => {
            const i = orderedSteps.length + j;
            const done = resultsFor(c.id).length;
            const full = done === exp.samples.length && exp.samples.length > 0;
            return (
              <button
                key={c.id}
                onClick={() => jumpTo(i)}
                title={c.name}
                className={
                  "shrink-0 w-10 h-10 rounded-full border flex flex-col items-center justify-center leading-none gap-0.5 " +
                  (i === slide
                    ? "bg-ink text-white border-ink"
                    : full
                      ? "bg-brand-soft text-brand-deep border-brand/40"
                      : done > 0
                        ? "bg-surface text-brand-deep border-brand/50"
                        : "bg-surface text-muted border-line")
                }
              >
                <Icon name={c.process.icon} size={14} />
              </button>
            );
          })}
        </div>
      </div>

      {/* Substrate regrouping: swap substrates between groups mid-experiment */}
      {planGroups.length > 0 && (
        <div className="shrink-0 border-b border-line bg-surface px-3 py-1.5">
          <button
            onClick={() => setShowRegroup((v) => !v)}
            className="w-full h-11 flex items-center justify-center gap-2 rounded-[6px] border border-brand/40 bg-brand-soft text-brand-deep text-[13px] font-semibold active:bg-brand/20"
          >
            <Icon name="Grid3x3" size={16} />
            {t("plan.regroup")}
            <Icon name={showRegroup ? "ChevronUp" : "ChevronDown"} size={16} />
          </button>
          {showRegroup && (
            <div className="pt-1.5 pb-1">
              <SubstrateBoard
                groups={planGroups}
                assignments={assignments}
                simCodes={Object.fromEntries(exp.samples.map((s) => [s.code, s.simCode]))}
                onMove={moveSubstrate}
              />
            </div>
          )}
        </div>
      )}

      {/* Swipeable card track: one card per step / characterization */}
      <div className="flex-1 min-h-0 flex flex-col">
        <div
          ref={trackRef}
          className="no-scrollbar flex-1 min-h-0 flex overflow-x-auto overflow-y-hidden snap-x snap-mandatory"
        >
          {orderedSteps.map((step, i) => (
            <div key={step.id} className="w-full shrink-0 snap-center overflow-y-auto p-3 sm:p-4">
              <div className="max-w-xl mx-auto">
                <div className="text-[10.5px] font-bold uppercase text-muted mb-1.5 px-0.5">
                  {t("cap.stepOf")} {i + 1} {t("cap.of")} {orderedSteps.length}
                </div>
                <BatchStepCapture
                  step={step}
                  layerName={layers.find((l) => l.code === step.layer)?.name}
                  expCode={exp.code}
                  samples={exp.samples}
                  groups={groups}
                  runId={runId}
                  executions={execsFor(step.id)}
                  onSaved={(list) => {
                    setExecutions((es) => [
                      ...es.filter((e) => !(e.stepId === step.id && list.some((x) => x.sampleId === e.sampleId))),
                      ...list,
                    ]);
                    advance();
                  }}
                  onCleared={(sampleIds) => {
                    setExecutions((es) =>
                      es.filter((e) => !(e.stepId === step.id && sampleIds.includes(e.sampleId)))
                    );
                  }}
                />
                {i === slideCount - 1 && <CompleteCard exp={exp} missing={missingTotal} />}
              </div>
            </div>
          ))}
          {orderedChars.map((c, ci) => (
            <div key={c.id} className="w-full shrink-0 snap-center overflow-y-auto p-3 sm:p-4">
              <div className="max-w-xl mx-auto">
                <div className="text-[10.5px] font-bold uppercase text-muted mb-1.5 px-0.5">
                  {t("cap.results")}
                </div>
                <PerSampleCharCapture
                  charId={c.id}
                  name={c.name}
                  icon={c.process.icon}
                  expCode={exp.code}
                  samples={exp.samples}
                  runId={runId}
                  results={results.filter((r) => r.characterizationId === c.id)}
                  onSaved={(r) => {
                    setResults((rs) => [
                      ...rs.filter((x) => !(x.characterizationId === r.characterizationId && x.sampleId === r.sampleId)),
                      r,
                    ]);
                  }}
                />
                {orderedSteps.length + ci === slideCount - 1 && (
                  <CompleteCard exp={exp} missing={missingTotal} />
                )}
              </div>
            </div>
          ))}
        </div>

      </div>
    </main>
  );
}

// ---------------- Complete experiment ----------------
//
// Lives on the very last capture card: once the lab work is done, one
// confirmed tap marks the whole experiment COMPLETE.

function CompleteCard({ exp, missing }: { exp: ExperimentFull; missing: number }) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [done, setDone] = useState(exp.status !== "IN_LAB");

  if (done) {
    return (
      <div className="mt-3 bg-brand-soft/50 border border-brand/40 rounded-[6px] p-3.5 flex items-center gap-2.5 flex-wrap">
        <Icon name="CheckCircle2" size={17} className="text-brand-deep shrink-0" />
        <span className="flex-1 text-[13px] font-bold text-brand-deep min-w-32">
          {t(exp.status === "COMPLETE" ? "cap.completed" : "wf.submitted")}
        </span>
        <Link
          href={`/experiments/${exp.id}/report`}
          className="h-9 flex items-center px-3.5 rounded-[5px] bg-ink text-white text-[12px] font-semibold shrink-0"
        >
          {t("cap.viewReport")}
        </Link>
      </div>
    );
  }

  return (
    <div className="mt-3 bg-surface border-2 border-line rounded-[6px] p-3.5">
      <div className="flex items-center gap-2.5 mb-2">
        <Icon name="FlagTriangleRight" size={16} className="text-charcoal shrink-0" />
        <div className="flex-1 min-w-40">
          <div className="text-[13px] font-bold">{t("wf.submitTitle")}</div>
          <div className={"text-[11px] mt-0.5 " + (missing > 0 ? "text-warn font-semibold" : "text-muted")}>
            {missing > 0 ? `${missing} ${t("cap.completeMissing")}` : t("wf.submitHint")}
          </div>
        </div>
      </div>
      <FieldLabel>{t("wf.submitNote")}</FieldLabel>
      <textarea
        className={inputCls + " resize-none mb-2.5"}
        rows={2}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="flex justify-end">
        {confirming ? (
          <span className="flex items-center gap-2 bg-warn-soft border border-warn-line rounded-[5px] px-2.5 py-1.5">
            <span className="text-[12px] font-semibold text-warn">{t("cap.completeQ")}</span>
            <button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                await submitForReview(exp.id, note);
                setBusy(false);
                setDone(true);
              }}
              className="text-[12px] font-bold text-brand-deep border border-brand/40 bg-surface rounded-[4px] px-3 py-1"
            >
              ✓
            </button>
            <button onClick={() => setConfirming(false)} className="text-[12px] font-semibold text-muted border border-line bg-surface rounded-[4px] px-3 py-1">
              ✕
            </button>
          </span>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            className="whitespace-nowrap bg-brand text-[#243000] rounded-[4px] px-4 py-2.5 text-[13px] font-bold flex items-center gap-1.5"
          >
            <Icon name="Check" size={14} /> {t("wf.submit")}
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------- Batch step capture ----------------
//
// Processing happens in batches: wash all the glass, spin coat the whole set.
// One confirmation applies the actuals to every sample in scope. Steps whose
// parameters vary by group are captured per group (values differ).

function BatchStepCapture({
  step,
  layerName,
  expCode,
  samples,
  groups,
  runId,
  executions,
  onSaved,
  onCleared,
}: {
  step: StepFull;
  layerName?: string;
  expCode: string;
  samples: SampleRow[];
  groups: string[];
  runId: string;
  executions: Execution[];
  onSaved: (list: Execution[]) => void;
  onCleared: (sampleIds: string[]) => void;
}) {
  const t = useT();
  const tt = useTerm();
  const hasVariations = step.parameters.some((p) => p.variations.length > 0);

  const capturedIds = useMemo(() => new Set(executions.map((x) => x.sampleId)), [executions]);

  // Selection is a set of samples, toggled per group or per sample; multiple
  // groups can be combined. Varied steps stay one group at a time (planned
  // values differ per group, so one form can't cover two groups).
  // Only the first sample starts selected — the user widens the scope
  // deliberately by tapping groups or "All samples".
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(samples.slice(0, 1).map((s) => s.id))
  );
  const [editing, setEditing] = useState(false);

  const targets = useMemo(() => samples.filter((s) => selectedIds.has(s.id)), [selectedIds, samples]);
  const allSelected = samples.length > 0 && selectedIds.size === samples.length;

  const toggleAll = () =>
    setSelectedIds(allSelected ? new Set() : new Set(samples.map((s) => s.id)));

  const toggleGroup = (g: string) => {
    const ids = samples.filter((s) => s.variationGroup === g).map((s) => s.id);
    setSelectedIds((prev) => {
      const has = ids.every((id) => prev.has(id));
      if (hasVariations) return has && prev.size === ids.length ? new Set() : new Set(ids);
      const next = new Set(prev);
      ids.forEach((id) => (has ? next.delete(id) : next.add(id)));
      return next;
    });
  };

  const toggleSample = (s: SampleRow) => {
    setSelectedIds((prev) => {
      // Varied steps: drop samples from other groups before toggling.
      const next = hasVariations
        ? new Set([...prev].filter((id) => samples.find((x) => x.id === id)?.variationGroup === s.variationGroup))
        : new Set(prev);
      if (prev.has(s.id)) next.delete(s.id);
      else next.add(s.id);
      return next;
    });
  };

  // Planned values resolve per group when the selection sits in one group.
  const scopeGroup =
    targets.length > 0 && targets.every((s) => s.variationGroup === targets[0].variationGroup)
      ? targets[0].variationGroup ?? null
      : null;

  const planned = useMemo(() => plannedFor(step, scopeGroup), [step, scopeGroup]);
  const plannedEnv = (step.environmentConditions ?? {}) as Record<string, string>;

  const existing = targets.length > 0 ? executions.find((x) => x.sampleId === targets[0].id) : undefined;
  const allTargetsCaptured = targets.length > 0 && targets.every((s) => capturedIds.has(s.id));

  const [actuals, setActuals] = useState<Record<string, string>>(() => existing?.actuals ?? planned);
  const [envActuals, setEnvActuals] = useState<Record<string, string>>(() => existing?.environmentConditions ?? plannedEnv);
  const [note, setNote] = useState(existing?.note ?? "");
  const [flagged, setFlagged] = useState(existing?.flagged ?? false);
  const [existingPhotos, setExistingPhotos] = useState<{ id: string; path: string }[]>(existing?.photos ?? []);
  const [newPhotos, setNewPhotos] = useState<string[]>([]);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [overwriteAsk, setOverwriteAsk] = useState(false);
  const [clearAsk, setClearAsk] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Undo an accidental confirm: remove the captured data for the selection
  // and reset the form back to planned values.
  const doClear = async () => {
    const ids = targets.map((sm) => sm.id);
    setBusy(true);
    await clearExecutions(runId, step.id, ids);
    setBusy(false);
    setClearAsk(false);
    setEditing(false);
    setActuals(plannedFor(step, scopeGroup));
    setEnvActuals(plannedEnv);
    setNote("");
    setFlagged(false);
    setExistingPhotos([]);
    setNewPhotos([]);
    setOverwriteAsk(false);
    onCleared(ids);
  };

  const clearControl = (
    clearAsk ? (
      <span className="flex items-center gap-1.5 bg-warn-soft border border-warn-line rounded-[4px] px-2 py-1">
        <span className="text-[11px] font-semibold text-warn whitespace-nowrap">{t("cap.clearQ")}</span>
        <button disabled={busy} onClick={doClear} className="p-0.5 text-danger" title={t("cap.clear")}>
          <Icon name="Check" size={13} />
        </button>
        <button onClick={() => setClearAsk(false)} className="p-0.5 text-muted">
          <Icon name="X" size={13} />
        </button>
      </span>
    ) : (
      <button
        onClick={() => setClearAsk(true)}
        className="whitespace-nowrap text-[11.5px] font-semibold text-warn border border-warn-line rounded-[4px] px-3 py-2 flex items-center gap-1.5 hover:bg-warn-soft"
      >
        <Icon name="Eraser" size={13} /> {t("cap.clear")}
      </button>
    )
  );

  // Re-seed the form whenever the selection changes. Deliberately leaves
  // `editing` alone: after "Edit capture", switching groups must keep showing
  // the form (seeded with that group's recorded data), not collapse again.
  const scopeKey = [...selectedIds].sort().join(",");
  const lastScopeKey = useRef(scopeKey);
  useEffect(() => {
    if (lastScopeKey.current === scopeKey) return;
    lastScopeKey.current = scopeKey;
    const ex = targets.length > 0 ? executions.find((x) => x.sampleId === targets[0].id) : undefined;
    setActuals(ex?.actuals ?? plannedFor(step, scopeGroup));
    setEnvActuals(ex?.environmentConditions ?? plannedEnv);
    setNote(ex?.note ?? "");
    setFlagged(ex?.flagged ?? false);
    setExistingPhotos(ex?.photos ?? []);
    setNewPhotos([]);
    setOverwriteAsk(false);
    setClearAsk(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

  const upload = async (files: FileList) => {
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/upload", { method: "POST", body: fd });
        const json = await res.json();
        if (json.fileName) setNewPhotos((p) => [...p, json.fileName]);
      }
    } finally {
      setUploading(false);
    }
  };

  const doSave = async () => {
    setBusy(true);
    setOverwriteAsk(false);
    const saved = await saveExecutionBatch(runId, step.id, targets.map((sm) => sm.id), {
      actuals, environmentConditions: envActuals, note, flagged,
      photoFileNames: newPhotos.length > 0 ? newPhotos : undefined,
    });
    setBusy(false);
    setEditing(false);
    setExistingPhotos(saved[0]?.attachments.map((a) => ({ id: a.id, path: a.storedPath })) ?? existingPhotos);
    setNewPhotos([]);
    onSaved(saved.map((x) => ({
      stepId: step.id,
      sampleId: x.sampleId,
      actuals,
      environmentConditions: envActuals,
      note,
      flagged,
      capturedAt: x.capturedAt.toISOString().replace("T", " ").slice(0, 16),
      photos: x.attachments.map((a) => ({ id: a.id, path: a.storedPath })),
    })));
  };

  // The scope selector IS the sample map: tap All, a group, or one sample.
  const groupBuckets = useMemo(
    () => groups.map((g) => ({ label: g, items: samples.filter((s) => s.variationGroup === g) })),
    [groups, samples]
  );
  const looseSamples = useMemo(() => samples.filter((s) => !s.variationGroup), [samples]);
  const allCaptured = samples.length > 0 && samples.every((s) => capturedIds.has(s.id));

  // Human label for the confirm button: All / whole groups / leftover codes.
  const selectionLabel = useMemo(() => {
    if (allSelected) return t("cap.batchAll");
    const fullGroups = groups.filter((g) => {
      const ids = samples.filter((s) => s.variationGroup === g);
      return ids.length > 0 && ids.every((s) => selectedIds.has(s.id));
    });
    const leftover = targets.filter(
      (s) => !s.variationGroup || !fullGroups.includes(s.variationGroup)
    );
    return [
      ...fullGroups.map((g) => `${t("cap.batchGroup")} ${g}`),
      ...leftover.map((s) => s.code),
    ].join(", ");
  }, [allSelected, groups, samples, selectedIds, targets, t]);

  // One segment of a group control. Tapping toggles that sample in/out of
  // the selection; selected segments go dark.
  const sampleSeg = (s: SampleRow) => {
    const selected = selectedIds.has(s.id);
    const captured = capturedIds.has(s.id);
    return (
      <button
        key={s.id}
        onClick={() => toggleSample(s)}
        className={
          "mono text-[11.5px] font-semibold px-2.5 flex items-center gap-1 " +
          (selected
            ? "bg-ink text-white"
            : captured
              ? "bg-brand-soft text-brand-deep"
              : "bg-surface text-charcoal")
        }
      >
        {s.code}
        {captured && <span className={selected ? "text-brand" : ""}>✓</span>}
      </button>
    );
  };

  return (
    <div className="bg-surface border-2 border-line rounded-[6px] p-3.5">
      <div className="flex items-center gap-2 mb-1.5">
        <Icon name={step.process.icon} size={15} className="text-charcoal" />
        <span className="text-[13px] font-bold flex-1 min-w-0 truncate">
          {String(step.position + 1).padStart(2, "0")} {tt(step.name)}
        </span>
        {step.equipment && <span className="mono text-[10.5px] text-muted shrink-0">{step.equipment.assetTag || step.equipment.model}</span>}
      </div>
      {layerName && (
        <div className="mb-2">
          <span className="text-[9.5px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-[3px] bg-ink/5 border border-ink/15 text-charcoal inline-flex items-center gap-1">
            <Icon name="Layers" size={9} /> {layerName}
          </span>
        </div>
      )}

      {/* Scope selector = sample map: tap All, a group, or a single sample;
          tap again to unselect. Hidden once the whole step is captured
          (Edit capture brings it back). Captured turns green with a check. */}
      {!(allCaptured && !editing && targets.length > 0) && (
        <div className="mb-3">
          <FieldLabel>{t("cap.applyTo")}</FieldLabel>
          <div className="flex flex-wrap items-stretch gap-1.5">
            {!hasVariations && (
              <button
                onClick={toggleAll}
                className={
                  "h-9 text-[12px] font-bold px-3 rounded-[6px] border flex items-center gap-1 " +
                  (allSelected
                    ? "bg-ink text-white border-ink"
                    : allCaptured
                      ? "bg-brand-soft text-brand-deep border-brand/40"
                      : "bg-surface text-charcoal border-line")
                }
              >
                {t("cap.batchAll")} ({samples.length})
                {allCaptured && <span className={allSelected ? "text-brand" : ""}>✓</span>}
              </button>
            )}
            {groupBuckets.map((b) => {
              const groupDone = b.items.length > 0 && b.items.every((s) => capturedIds.has(s.id));
              const groupSelected = b.items.length > 0 && b.items.every((s) => selectedIds.has(s.id));
              return (
                <div
                  key={b.label}
                  className={
                    "flex items-stretch h-9 rounded-[6px] border overflow-hidden divide-x " +
                    (groupSelected
                      ? "border-ink divide-white/20"
                      : groupDone
                        ? "border-brand/40 divide-brand/30"
                        : "border-line divide-line")
                  }
                >
                  <button
                    onClick={() => toggleGroup(b.label)}
                    className={
                      "text-[11px] font-bold whitespace-nowrap px-2.5 flex items-center gap-1 " +
                      (groupSelected
                        ? "bg-ink text-white"
                        : groupDone
                          ? "bg-brand-soft text-brand-deep"
                          : "bg-subtle text-charcoal")
                    }
                  >
                    {t("cap.batchGroup")} {b.label}
                    {groupDone && <span className={groupSelected ? "text-brand" : ""}>✓</span>}
                  </button>
                  {b.items.map(sampleSeg)}
                </div>
              );
            })}
            {looseSamples.length > 0 && (
              <div className="flex items-stretch h-9 rounded-[6px] border border-line overflow-hidden divide-x divide-line">
                {looseSamples.map(sampleSeg)}
              </div>
            )}
          </div>
          {targets.length === 1 && (
          <p className="mono text-[11px] text-charcoal mt-1.5">
            <Icon name="Tag" size={10} className="inline mr-1 text-muted" />
            {expCode}-{targets[0].code}
          </p>
        )}
        <p className="text-[10px] text-muted mt-1">{t("cap.batchHint")}</p>
        </div>
      )}

      {targets.length === 0 ? (
        <div className="border border-dashed border-line rounded-[5px] px-3 py-5 text-center text-[12px] text-muted">
          {t("cap.pickScope")}
        </div>
      ) : allTargetsCaptured && !editing ? (
        <div className="bg-brand-soft/50 border border-brand/40 rounded-[5px] px-3 py-2.5">
          <div className="flex items-center gap-2 flex-wrap">
            <Icon name="CheckCircle2" size={15} className="text-brand-deep" />
            <span className="text-[12.5px] text-brand-deep font-semibold flex-1 min-w-32">
              {t("cap.confirmed")} · {targets.length === 1
                ? `${expCode}-${targets[0].code}`
                : targets.map((s) => s.code).join(", ")}
            </span>
            {clearAsk ? (
              <span className="flex items-center gap-1.5 bg-warn-soft border border-warn-line rounded-[4px] px-2 py-1">
                <span className="text-[11px] font-semibold text-warn whitespace-nowrap">{t("cap.clearQ")}</span>
                <button disabled={busy} onClick={doClear} className="p-0.5 text-danger" title={t("cap.clear")}>
                  <Icon name="Check" size={13} />
                </button>
                <button onClick={() => setClearAsk(false)} className="p-0.5 text-muted">
                  <Icon name="X" size={13} />
                </button>
              </span>
            ) : (
              <button
                onClick={() => setClearAsk(true)}
                className="text-[11.5px] font-semibold text-warn flex items-center gap-1"
              >
                <Icon name="Eraser" size={12} /> {t("cap.clear")}
              </button>
            )}
            <button onClick={() => setEditing(true)} className="text-[11.5px] font-semibold text-brand-deep underline">
              {t("cap.edit")}
            </button>
          </div>
          <div className="flex items-center gap-1.5 mt-2">
            {existingPhotos.slice(0, 5).map((ph) => (
              <button key={ph.path} onClick={() => setGalleryOpen(true)} className="shrink-0">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/files/${ph.path}`} alt="" className="h-11 w-11 object-cover rounded-[4px] border border-line" />
              </button>
            ))}
            {existingPhotos.length > 5 && (
              <button onClick={() => setGalleryOpen(true)} className="h-11 w-11 rounded-[4px] border border-line bg-surface text-[11px] font-bold text-muted">
                +{existingPhotos.length - 5}
              </button>
            )}
            <button
              onClick={() => setGalleryOpen(true)}
              className="h-11 px-3 rounded-[4px] border border-dashed border-line text-[11px] font-semibold text-muted flex items-center gap-1.5"
            >
              <Icon name="Camera" size={13} /> {t("cap.photos")} ({existingPhotos.length})
            </button>
          </div>
        </div>
      ) : (
        <>
          {step.parameters.length > 0 && (
            <div className="space-y-1.5 mb-3">
              <div className="grid grid-cols-[1fr_76px_96px_40px] gap-1.5 text-[10px] font-bold uppercase text-muted">
                <span>{t("insp.parameter")}</span>
                <span>{t("cap.planned")}</span>
                <span>{t("cap.actual")}</span>
                <span />
              </div>
              {step.parameters.map((p) => {
                const plan = planned[p.name] ?? "";
                const varied = p.variations.length > 0;
                return (
                  <div key={p.id} className="grid grid-cols-[1fr_76px_96px_40px] gap-1.5 items-center">
                    <span className={"text-[12px] truncate " + (varied ? "font-bold text-brand-deep" : "text-charcoal")}>
                      {tt(p.name)}
                    </span>
                    <span className="mono text-[12px] text-muted truncate">{plan}</span>
                    <input
                      className="h-9 mono border border-line rounded-[3px] px-2 text-[13px]"
                      value={actuals[p.name] ?? ""}
                      onChange={(e) => setActuals((a) => ({ ...a, [p.name]: e.target.value }))}
                    />
                    <span className="text-[10.5px] text-muted truncate">{p.unit}</span>
                  </div>
                );
              })}
            </div>
          )}

          {step.environment && Object.keys(plannedEnv).length > 0 && (
            <div className="mb-3">
              <FieldLabel>{t("cap.environment")} — {tt(step.environment.name)}</FieldLabel>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                {Object.entries(plannedEnv).map(([k, v]) => (
                  <label key={k} className="text-[11px] text-charcoal">
                    {tt(k)}
                    <input
                      className="h-9 mono w-full border border-line rounded-[3px] px-2 text-[13px] mt-0.5"
                      placeholder={v}
                      value={envActuals[k] ?? ""}
                      onChange={(e) => setEnvActuals((a) => ({ ...a, [k]: e.target.value }))}
                    />
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="mb-3">
            <FieldLabel>{t("cap.note")}</FieldLabel>
            <textarea
              className={inputCls + " resize-none"}
              rows={2}
              placeholder={t("cap.notePh")}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>

          {/* Photos: tap any thumbnail to open the gallery manager */}
          {(existingPhotos.length > 0 || newPhotos.length > 0) && (
            <div className="mb-2.5">
              <FieldLabel>{t("cap.photos")}</FieldLabel>
              <div className="no-scrollbar flex gap-1.5 overflow-x-auto">
                {existingPhotos.map((ph) => (
                  <button key={ph.path} onClick={() => setGalleryOpen(true)} className="shrink-0">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/api/files/${ph.path}`} alt="" className="h-14 w-14 object-cover rounded-[4px] border border-line" />
                  </button>
                ))}
                {newPhotos.map((ph) => (
                  <span key={ph} className="relative shrink-0">
                    <button onClick={() => setGalleryOpen(true)}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={`/api/files/${ph}`} alt="" className="h-14 w-14 object-cover rounded-[4px] border border-brand/50" />
                    </button>
                    <button
                      onClick={() => setNewPhotos((p) => p.filter((x) => x !== ph))}
                      className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-ink text-white flex items-center justify-center"
                    >
                      <Icon name="X" size={11} />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Overwrite confirmation: some targets already have captures */}
          {overwriteAsk && (
            <div className="mb-2.5 bg-warn-soft border border-warn-line rounded-[5px] px-3 py-2.5">
              <p className="text-[12px] font-semibold text-warn mb-1.5">
                {t("cap.overwriteQ")}{" "}
                <span className="mono">
                  {targets.filter((sm) => capturedIds.has(sm.id)).map((sm) => sm.code).join(", ")}
                </span>
              </p>
              <div className="flex gap-2">
                <button
                  disabled={busy}
                  onClick={() => doSave()}
                  className="text-[12px] font-bold text-danger border border-warn-line rounded-[4px] px-3 py-1.5 bg-surface"
                >
                  {t("cap.overwrite")}
                </button>
                <button
                  onClick={() => setOverwriteAsk(false)}
                  className="text-[12px] font-semibold text-muted border border-line rounded-[4px] px-3 py-1.5 bg-surface"
                >
                  {t("plan.cancel")}
                </button>
              </div>
            </div>
          )}

          <div className="flex items-center gap-2">
            <input ref={fileRef} type="file" accept="image/*" multiple className="hidden"
              onChange={(e) => e.target.files?.length && upload(e.target.files)} />
            <button
              disabled={busy || targets.length === 0}
              onClick={() => {
                // Overwriting existing captures needs an explicit confirmation
                // (e.g. batching "All samples" over groups already recorded).
                const overwrites = targets.filter((sm) => capturedIds.has(sm.id));
                const intentionalEdit = editing && overwrites.length === targets.length;
                if (overwrites.length > 0 && !intentionalEdit && !overwriteAsk) {
                  setOverwriteAsk(true);
                  return;
                }
                void doSave();
              }}
              className="flex-1 min-w-0 h-11 whitespace-nowrap bg-brand text-[#243000] rounded-[6px] px-4 text-[13.5px] font-bold disabled:opacity-50 flex items-center justify-center gap-1.5"
            >
              <Icon name="Check" size={15} />
              <span className="truncate">{t("cap.confirmFor")} {selectionLabel} ({targets.length})</span>
            </button>
            <button onClick={() => fileRef.current?.click()} disabled={uploading}
              title={t("cap.addPhoto")}
              className="relative shrink-0 w-11 h-11 rounded-full border border-line bg-surface text-charcoal flex items-center justify-center hover:bg-subtle disabled:opacity-50">
              <Icon name="Camera" size={17} />
              {newPhotos.length > 0 && (
                <span className="absolute -top-1 -right-1 mono text-[9px] font-bold bg-ink text-white rounded-full w-4 h-4 flex items-center justify-center">
                  {newPhotos.length}
                </span>
              )}
            </button>
            <button onClick={() => setFlagged(!flagged)}
              title={t("cap.flag")}
              className={"shrink-0 w-11 h-11 rounded-full border flex items-center justify-center " +
                (flagged ? "bg-warn-soft text-warn border-warn-line" : "border-line bg-surface text-muted hover:bg-subtle")}>
              <Icon name="Flag" size={17} />
            </button>
            {targets.some((sm) => capturedIds.has(sm.id)) && (
              <span className="shrink-0">{clearControl}</span>
            )}
          </div>
        </>
      )}

      {galleryOpen && (
        <PhotoGallery
          photos={[...existingPhotos, ...newPhotos.map((p) => ({ path: p }))]}
          onClose={() => setGalleryOpen(false)}
          onDelete={async (photo) => {
            if (photo.id) {
              await deleteExecutionPhoto(photo.id);
              setExistingPhotos((ps) => ps.filter((x) => x.id !== photo.id));
            } else {
              setNewPhotos((ps) => ps.filter((x) => x !== photo.path));
            }
          }}
          onAdd={async (files) => {
            const uploaded: string[] = [];
            for (const file of Array.from(files)) {
              const fd = new FormData();
              fd.append("file", file);
              const res = await fetch("/api/upload", { method: "POST", body: fd });
              const json = await res.json();
              if (json.fileName) uploaded.push(json.fileName);
            }
            if (uploaded.length === 0) return;
            const capturedTargets = targets.filter((sm) => capturedIds.has(sm.id));
            if (capturedTargets.length > 0) {
              // Step already captured for this scope — attach immediately.
              const fresh = await addExecutionPhotos(runId, step.id, capturedTargets.map((sm) => sm.id), uploaded);
              if (fresh.length > 0) setExistingPhotos(fresh);
            } else {
              // Not captured yet — keep pending until the step is confirmed.
              setNewPhotos((ps) => [...ps, ...uploaded]);
            }
          }}
        />
      )}
    </div>
  );
}

// ---------------- Photo gallery: view, delete, add ----------------

function PhotoGallery({
  photos,
  onClose,
  onDelete,
  onAdd,
}: {
  photos: PhotoRef[];
  onClose: () => void;
  onDelete: (photo: PhotoRef) => Promise<void>;
  onAdd: (files: FileList) => Promise<void>;
}) {
  const t = useT();
  const [viewing, setViewing] = useState<PhotoRef | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <div className="fixed inset-0 z-50 bg-ink/40 flex items-end sm:items-center justify-center" onClick={onClose}>
      <div
        className="w-full sm:max-w-lg bg-surface rounded-t-[10px] sm:rounded-[10px] border border-line max-h-[85dvh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-line">
          <Icon name="Camera" size={15} className="text-charcoal" />
          <h3 className="text-[14px] font-bold flex-1">{t("cap.photos")} ({photos.length})</h3>
          <button onClick={onClose} className="p-1.5 rounded-[3px] text-muted hover:bg-subtle">
            <Icon name="X" size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {photos.length === 0 ? (
            <p className="text-[13px] text-muted text-center py-8">{t("cap.noPhotos")}</p>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {photos.map((ph) => (
                <div key={ph.path} className="relative aspect-square">
                  <button onClick={() => setViewing(ph)} className="w-full h-full">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/api/files/${ph.path}`} alt="" className="w-full h-full object-cover rounded-[6px] border border-line" />
                  </button>
                  {confirming === ph.path ? (
                    <span className="absolute bottom-1.5 left-1.5 right-1.5 flex items-center justify-center gap-1 bg-surface/95 border border-warn-line rounded-[4px] py-1">
                      <span className="text-[10px] font-semibold text-warn">{t("card.deleteQ")}</span>
                      <button
                        disabled={busy}
                        onClick={async () => {
                          setBusy(true);
                          await onDelete(ph);
                          setBusy(false);
                          setConfirming(null);
                        }}
                        className="p-0.5 text-danger"
                      >
                        <Icon name="Check" size={13} />
                      </button>
                      <button onClick={() => setConfirming(null)} className="p-0.5 text-muted">
                        <Icon name="X" size={13} />
                      </button>
                    </span>
                  ) : (
                    <button
                      onClick={() => setConfirming(ph.path)}
                      className="absolute top-1.5 right-1.5 w-7 h-7 rounded-full bg-ink/70 text-white flex items-center justify-center"
                    >
                      <Icon name="Trash2" size={13} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t border-line">
          <input ref={fileRef} type="file" accept="image/*" multiple className="hidden"
            onChange={async (e) => {
              if (!e.target.files?.length) return;
              setBusy(true);
              await onAdd(e.target.files);
              setBusy(false);
              e.target.value = "";
            }} />
          <button
            disabled={busy}
            onClick={() => fileRef.current?.click()}
            className="w-full h-11 bg-brand text-[#243000] rounded-[6px] text-[13.5px] font-bold disabled:opacity-50 flex items-center justify-center gap-2"
          >
            <Icon name="Camera" size={15} /> {busy ? t("lib.uploading") : t("cap.addPhoto")}
          </button>
        </div>
      </div>

      {/* Full-size viewer */}
      {viewing && (
        <div className="fixed inset-0 z-[60] bg-ink/90 flex items-center justify-center p-3" onClick={(e) => { e.stopPropagation(); setViewing(null); }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/api/files/${viewing.path}`} alt="" className="max-w-full max-h-full object-contain rounded-[6px]" />
          <button className="absolute top-4 right-4 w-10 h-10 rounded-full bg-ink/70 text-white flex items-center justify-center">
            <Icon name="X" size={18} />
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------- Per-sample characterization capture ----------------
//
// Measurements are taken one sample at a time — the sample selector lives
// inside the card, and saving advances to the next unmeasured sample.

function PerSampleCharCapture({
  charId,
  name,
  icon,
  expCode,
  samples,
  runId,
  results,
  onSaved,
}: {
  charId: string;
  name: string;
  icon: string;
  expCode: string;
  samples: SampleRow[];
  runId: string;
  results: CharResult[];
  onSaved: (r: CharResult) => void;
}) {
  const t = useT();
  const tt = useTerm();
  const hasResult = (sampleId: string) => {
    const r = results.find((x) => x.sampleId === sampleId);
    return !!r && Object.values(r.metrics).some((v) => v !== "");
  };

  const [activeSampleId, setActiveSampleId] = useState<string>(
    () => samples.find((s) => !hasResult(s.id))?.id ?? samples[0]?.id ?? ""
  );

  // Samples bucketed by variation group; ungrouped ones trail in a plain pill.
  const sampleBuckets = useMemo(() => {
    const out: { label: string | null; items: SampleRow[] }[] = [];
    for (const s of samples) {
      const label = s.variationGroup ?? null;
      const b = out.find((x) => x.label === label);
      if (b) b.items.push(s);
      else out.push({ label, items: [s] });
    }
    return out.sort((a, b) =>
      a.label === null ? 1 : b.label === null ? -1 : a.label.localeCompare(b.label)
    );
  }, [samples]);
  const activeSample = samples.find((s) => s.id === activeSampleId);
  const activeResult = results.find((r) => r.sampleId === activeSampleId);

  const [metrics, setMetrics] = useState<[string, string][]>(() =>
    Object.entries(activeResult?.metrics ?? metricDefaults(name))
  );
  const [busy, setBusy] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [policyBusy, setPolicyBusy] = useState(false);

  const changePolicy = async (policy: string) => {
    if (!activeResult?.id) return;
    setPolicyBusy(true);
    try {
      const r = await setJvDisplayPolicy(activeResult.id, policy);
      onSaved({
        id: r.id,
        characterizationId: r.characterizationId,
        sampleId: r.sampleId ?? "",
        metrics: (r.metrics ?? {}) as Record<string, string>,
        note: r.note,
        source: r.source,
        metricPolicy: r.metricPolicy,
      });
      setMetrics(Object.entries((r.metrics ?? {}) as Record<string, string>));
    } finally {
      setPolicyBusy(false);
    }
  };

  // Re-seed metrics when the active sample changes.
  const lastSample = useRef(activeSampleId);
  useEffect(() => {
    if (lastSample.current === activeSampleId) return;
    lastSample.current = activeSampleId;
    const r = results.find((x) => x.sampleId === activeSampleId);
    setMetrics(Object.entries(
      r?.metrics && Object.keys(r.metrics).length > 0 ? r.metrics : metricDefaults(name)
    ));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSampleId]);

  const doneCount = samples.filter((s) => hasResult(s.id)).length;

  return (
    <div className="bg-surface border-2 border-line rounded-[6px] p-3.5">
      <div className="flex items-center gap-2 mb-1.5">
        <Icon name={icon} size={15} className="text-charcoal" />
        <span className="text-[13px] font-bold flex-1 min-w-0 truncate">{tt(name)}</span>
        <span className="mono text-[10.5px] text-muted shrink-0">{doneCount}/{samples.length}</span>
      </div>
      <p className="text-[10px] text-muted mb-2">{t("cap.perSampleHint")}</p>

      {/* Sample selector — segmented group pills, wrapping (no side-scroll):
          active sample is dark, measured samples are green with a check */}
      <div className="mb-3 flex flex-wrap items-stretch gap-1.5">
        {sampleBuckets.map((b) => {
          const bucketDone = b.items.every((s) => hasResult(s.id));
          return (
            <div
              key={b.label ?? "__none__"}
              className={
                "flex items-stretch h-9 rounded-[6px] border overflow-hidden divide-x " +
                (bucketDone ? "border-brand/40 divide-brand/30" : "border-line divide-line")
              }
            >
              {b.label && (
                <span
                  className={
                    "text-[11px] font-bold whitespace-nowrap px-2.5 flex items-center " +
                    (bucketDone ? "bg-brand-soft text-brand-deep" : "bg-subtle text-charcoal")
                  }
                >
                  {t("cap.batchGroup")} {b.label}{bucketDone && " ✓"}
                </span>
              )}
              {b.items.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setActiveSampleId(s.id)}
                  className={
                    "mono text-[11.5px] font-semibold px-2.5 flex items-center gap-1 " +
                    (s.id === activeSampleId
                      ? "bg-ink text-white"
                      : hasResult(s.id)
                        ? "bg-brand-soft text-brand-deep"
                        : "bg-surface text-charcoal")
                  }
                >
                  {s.code}
                  {hasResult(s.id) && <span className={s.id === activeSampleId ? "text-brand" : ""}>✓</span>}
                </button>
              ))}
            </div>
          );
        })}
      </div>

      {activeSample && (
        <div className="mb-2">
          <p className="mono text-[11px] text-charcoal">
            <Icon name="Tag" size={10} className="inline mr-1 text-muted" />
            {expCode}-{activeSample.code}
          </p>
          {activeSample.simCode && (
            <div className="mt-1.5 inline-flex items-baseline gap-2 bg-ink text-white rounded-[6px] px-3 py-1.5">
              <span className="text-[10px] font-bold uppercase tracking-wide opacity-70">
                {t("cap.simCode")}
              </span>
              <span className="mono text-[20px] font-bold tracking-widest">
                {activeSample.simCode}
              </span>
            </div>
          )}
          {activeResult?.source === "INSTRUMENT" && activeResult.id && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] text-muted">{t("cap.scanPolicy")}</span>
              {(["BEST", "MIN", "AVERAGE", "MEDIAN"] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  disabled={policyBusy}
                  onClick={() => changePolicy(p)}
                  className={
                    "h-6 px-2 text-[10.5px] font-semibold rounded-[4px] border disabled:opacity-50 " +
                    ((activeResult.metricPolicy ?? "BEST") === p
                      ? "bg-ink text-white border-ink"
                      : "bg-surface text-charcoal border-line")
                  }
                >
                  {t(`cap.policy.${p}` as TKey)}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="space-y-1.5">
        {metrics.map(([k, v], i) => (
          <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(72px,96px)] gap-1.5 items-center">
            <input
              className="h-9 w-full min-w-0 border border-line rounded-[3px] px-2 text-[13px]"
              placeholder={t("cap.metric")}
              value={k}
              onChange={(e) => setMetrics((m) => m.map((x, j) => (j === i ? [e.target.value, x[1]] : x)))}
            />
            <input
              className="h-9 w-full min-w-0 mono border border-line rounded-[3px] px-2 text-[13px]"
              placeholder={t("cap.value")}
              value={v}
              onChange={(e) => setMetrics((m) => m.map((x, j) => (j === i ? [x[0], e.target.value] : x)))}
            />
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2.5 mt-2.5">
        <button
          onClick={() => setMetrics((m) => [...m, ["", ""]])}
          className="text-[11px] font-semibold text-brand-deep flex items-center gap-1"
        >
          <Icon name="Plus" size={11} /> {t("cap.addMetric")}
        </button>
        <span className="flex-1" />
        {savedFlash && <span className="text-[11px] text-brand-deep">{t("cap.resultSaved")}</span>}
        <button
          disabled={busy || !activeSample}
          onClick={async () => {
            if (!activeSample) return;
            setBusy(true);
            const clean = Object.fromEntries(metrics.filter(([k]) => k.trim()));
            await saveCharResult(charId, activeSample.id, clean, "", runId);
            setBusy(false);
            setSavedFlash(true);
            setTimeout(() => setSavedFlash(false), 1500);
            onSaved({ characterizationId: charId, sampleId: activeSample.id, metrics: clean, note: "" });
            // Advance to the next sample without a result.
            const next = samples.find((s) => s.id !== activeSample.id && !hasResult(s.id));
            if (next) setActiveSampleId(next.id);
          }}
          className="whitespace-nowrap bg-brand text-[#243000] rounded-[4px] px-4 py-2.5 text-[13px] font-bold disabled:opacity-50 flex items-center gap-1.5"
        >
          <Icon name="Check" size={14} /> {t("cap.saveResult")} · {activeSample?.code}
        </button>
      </div>
    </div>
  );
}
