"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { Equipment, Material, Preset, LabEnvironment, Process } from "@prisma/client";
import type { ExperimentFull, StepFull, CharFull, StepDraft, CharDraft } from "@/lib/types";
import { STATUS_META, type TestPlan } from "@/lib/library";
import {
  addStep, saveStep, deleteStep, reorderSteps,
  addCharacterization, saveCharacterization, deleteCharacterization,
  updateExperimentMeta, deleteExperiment, saveStepPreset, saveCharPreset,
  addMember, removeMember, quickCreateMaterial, applyTestPlan,
} from "@/lib/actions/experiments";
import { Icon } from "@/components/ui";
import { useT, useTerm } from "@/lib/i18n/LanguageProvider";
import { usePointerDrag } from "@/lib/usePointerDrag";
import { ReviewPanel } from "./ReviewPanel";
import { TeamStrip } from "./TeamStrip";
import { ScienceStrip } from "./ScienceStrip";
import { TestPlanCard } from "./TestPlanCard";
import { SettingsModal } from "./SettingsModal";
import { StepCard, CharCard } from "./cards";
import { StepInspector, CharInspector, EmptyInspector } from "./inspectors";

export type Selection = { kind: "none" } | { kind: "step"; id: string } | { kind: "char"; id: string };
export type SaveState = "saved" | "saving" | "error";

export default function Designer({
  initial,
  processes,
  equipment,
  materials: initialMaterials,
  environments,
  presets: initialPresets,
  orgUsers,
  recipes,
  layers,
  categoryLayers = [],
  canManageMaterials,
  canEdit,
  canManageMembers,
}: {
  initial: ExperimentFull;
  processes: Process[];
  equipment: Equipment[];
  materials: Material[];
  environments: LabEnvironment[];
  presets: Preset[];
  orgUsers: { id: string; name: string; email: string; role: string }[];
  recipes: { id: string; name: string; summary: string }[];
  layers: { code: string; name: string }[];
  categoryLayers?: { code: string; layers: string[] }[];
  canManageMaterials: boolean;
  canEdit: boolean;
  canManageMembers: boolean;
}) {
  const t = useT();
  const tt = useTerm();
  const [exp, setExp] = useState<ExperimentFull>(initial);
  const [materials, setMaterials] = useState<Material[]>(initialMaterials);
  const [presets, setPresets] = useState<Preset[]>(initialPresets);
  const [selection, setSelection] = useState<Selection>({ kind: "none" });
  const [showSettings, setShowSettings] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const dragIdRef = useRef<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);
  // Mobile: the process library lives in a bottom sheet instead of a rail.
  const [addSheet, setAddSheet] = useState<null | "step" | "char">(null);
  const pendingOps = useRef(0);

  const track = useCallback(async <T,>(op: Promise<T>): Promise<T | null> => {
    pendingOps.current += 1;
    setSaveState("saving");
    try {
      const result = await op;
      pendingOps.current -= 1;
      if (pendingOps.current === 0) setSaveState("saved");
      return result;
    } catch (err) {
      pendingOps.current -= 1;
      setSaveState("error");
      console.error(err);
      return null;
    }
  }, []);

  const groups = useMemo(() => {
    const set = new Set<string>();
    for (const s of exp.samples) if (s.variationGroup) set.add(s.variationGroup);
    return [...set].sort();
  }, [exp.samples]);

  const orderedSteps = useMemo(() => [...exp.steps].sort((a, b) => a.position - b.position), [exp.steps]);
  const processingProcs = useMemo(() => processes.filter((p) => p.kind === "PROCESSING"), [processes]);
  const charProcs = useMemo(() => processes.filter((p) => p.kind === "CHARACTERIZATION"), [processes]);
  const testPlan = ((exp.metadata as { testPlan?: TestPlan } | null)?.testPlan) ?? null;

  // ---- steps ----

  const handleAddStep = async (processId: string) => {
    const step = await track(addStep(exp.id, processId));
    if (step) {
      setExp((e) => ({ ...e, steps: [...e.steps, step as StepFull] }));
      setSelection({ kind: "step", id: step.id });
    }
  };

  const handleSaveStep = async (stepId: string, draft: StepDraft, appliedPresetId: string | null) => {
    const full = await track(saveStep(stepId, draft, appliedPresetId));
    if (full) {
      setExp((e) => ({ ...e, steps: e.steps.map((s) => (s.id === stepId ? (full as StepFull) : s)) }));
      if (appliedPresetId) {
        setPresets((ps) => ps.map((p) => (p.id === appliedPresetId ? { ...p, usageCount: p.usageCount + 1 } : p)));
      }
    }
  };

  const handleDeleteStep = async (stepId: string) => {
    setExp((e) => ({
      ...e,
      steps: e.steps.filter((s) => s.id !== stepId).map((s, i) => ({ ...s, position: i })),
    }));
    if (selection.kind === "step" && selection.id === stepId) setSelection({ kind: "none" });
    await track(deleteStep(stepId));
  };

  const handleDrop = async (targetId: string) => {
    const dragId = dragIdRef.current;
    if (!dragId || dragId === targetId) return;
    const ids = orderedSteps.map((s) => s.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    ids.splice(from, 1);
    ids.splice(to, 0, dragId);
    setExp((e) => ({
      ...e,
      steps: e.steps.map((s) => ({ ...s, position: ids.indexOf(s.id) })),
    }));
    dragIdRef.current = null;
    setDropId(null);
    await track(reorderSteps(exp.id, ids));
  };

  // Touch-capable reorder: pointer drag from the card's grip handle (HTML5
  // drag events never fire on touch screens, so both paths are wired).
  const canvasRef = useRef<HTMLElement>(null);
  const startStepDrag = usePointerDrag({
    attr: "data-drop-step",
    onHover: setDropId,
    onDrop: (dragged, target) => {
      dragIdRef.current = dragged;
      void handleDrop(target);
    },
    scrollEls: () => [canvasRef.current],
  });

  // ---- characterizations ----

  const handleAddChar = async (processId: string) => {
    const c = await track(addCharacterization(exp.id, processId));
    if (c) {
      setExp((e) => ({ ...e, characterizations: [...e.characterizations, c as CharFull] }));
      setSelection({ kind: "char", id: c.id });
    }
  };

  const handleSaveChar = async (id: string, draft: CharDraft, appliedPresetId: string | null) => {
    const full = await track(saveCharacterization(id, draft, appliedPresetId));
    if (full) {
      setExp((e) => ({
        ...e,
        characterizations: e.characterizations.map((c) => (c.id === id ? (full as CharFull) : c)),
      }));
      if (appliedPresetId) {
        setPresets((ps) => ps.map((p) => (p.id === appliedPresetId ? { ...p, usageCount: p.usageCount + 1 } : p)));
      }
    }
  };

  const handleDeleteChar = async (id: string) => {
    setExp((e) => ({ ...e, characterizations: e.characterizations.filter((c) => c.id !== id) }));
    if (selection.kind === "char" && selection.id === id) setSelection({ kind: "none" });
    await track(deleteCharacterization(id));
  };

  // ---- experiment-level ----

  const handleMeta = (patch: Parameters<typeof updateExperimentMeta>[1]) => {
    setExp((e) => ({ ...e, ...patch }));
    void track(updateExperimentMeta(exp.id, patch));
  };

  const handleAddMember = async (userId: string) => {
    const members = await track(addMember(exp.id, userId));
    if (members) setExp((e) => ({ ...e, members: members as ExperimentFull["members"] }));
  };

  const handleRemoveMember = async (userId: string) => {
    const members = await track(removeMember(exp.id, userId));
    if (members) setExp((e) => ({ ...e, members: members as ExperimentFull["members"] }));
  };

  const handleCreateMaterial = async (name: string, processId: string | null) => {
    const m = await track(quickCreateMaterial(name, processId));
    if (m) setMaterials((ms) => [...ms, m].sort((a, b) => a.name.localeCompare(b.name)));
    return m;
  };

  const handleApplyTestPlan = async (plan: TestPlan) => {
    const fresh = await track(applyTestPlan(exp.id, plan));
    if (fresh) setExp(fresh as ExperimentFull);
  };

  const handleSaveStepPreset = async (name: string, draft: StepDraft) => {
    if (selection.kind !== "step") return;
    const step = exp.steps.find((s) => s.id === selection.id);
    if (!step) return;
    const preset = await track(
      saveStepPreset(name, step.processId, {
        equipmentId: draft.equipmentId,
        environmentId: draft.environmentId,
        environmentConditions: draft.environmentConditions,
        materials: draft.materials.filter((m) => m.materialId),
        parameters: draft.parameters.map((p) => ({ name: p.name, unit: p.unit, value: p.value, source: p.source })),
      })
    );
    if (preset) setPresets((ps) => [...ps, preset]);
  };

  const handleSaveCharPreset = async (name: string, draft: CharDraft) => {
    if (selection.kind !== "char") return;
    const char = exp.characterizations.find((c) => c.id === selection.id);
    if (!char) return;
    const preset = await track(
      saveCharPreset(name, char.processId, {
        equipmentId: draft.equipmentId,
        environmentId: draft.environmentId,
        environmentConditions: draft.environmentConditions,
        settings: draft.settings,
        sampleScope: draft.sampleScope,
      })
    );
    if (preset) setPresets((ps) => [...ps, preset]);
  };

  const selectedStep = selection.kind === "step" ? exp.steps.find((s) => s.id === selection.id) : undefined;
  const selectedChar = selection.kind === "char" ? exp.characterizations.find((c) => c.id === selection.id) : undefined;
  const status = STATUS_META[exp.status];

  return (
    <div className="h-full flex flex-col">
      <div className="h-11 shrink-0 flex items-center gap-3 px-3 sm:px-4 border-b border-line bg-surface overflow-x-auto no-scrollbar whitespace-nowrap">
        <span className="mono font-bold text-[13px] shrink-0">{exp.code}</span>
        <span className="text-[13px] text-charcoal truncate max-w-36 sm:max-w-96">{exp.title}</span>
        <span
          className={
            "shrink-0 text-[11px] font-semibold px-2 py-0.5 rounded-[4px] border " +
            (status.tone === "brand"
              ? "bg-brand-soft text-brand-deep border-brand/40"
              : status.tone === "warning"
                ? "bg-warn-soft text-warn border-warn-line"
                : "bg-subtle text-muted border-line")
          }
        >
          {t(`status.${exp.status}` as "status.DRAFT")}
        </span>
        {!canEdit && (
          <span className="shrink-0 text-[11px] text-muted border border-line rounded-[4px] px-2 py-0.5 bg-subtle">
            {t("designer.readonly")}
          </span>
        )}
        <div className="flex-1" />
        {exp.status === "COMPLETE" && (
          <Link
            href={`/experiments/${exp.id}/report`}
            className="shrink-0 h-8 text-xs font-semibold text-charcoal border border-line rounded-[4px] px-3 hover:bg-subtle flex items-center gap-1.5"
          >
            <Icon name="FileText" size={13} />
            {t("rep.title")}
          </Link>
        )}
        {(exp.status === "IN_LAB" || exp.status === "COMPLETE") && (
          <Link
            href={`/experiments/${exp.id}/results`}
            className="shrink-0 h-8 text-xs font-semibold text-charcoal border border-line rounded-[4px] px-3 hover:bg-subtle flex items-center gap-1.5"
          >
            <Icon name="BarChart3" size={13} />
            {t("res.title")}
          </Link>
        )}
        {exp.status === "IN_LAB" && (
          <Link
            href={`/experiments/${exp.id}/capture`}
            className="shrink-0 h-8 text-xs font-bold bg-brand text-[#243000] rounded-[4px] px-3 flex items-center gap-1.5"
          >
            <Icon name="ClipboardPen" size={13} />
            {t("dash.capture")}
          </Link>
        )}
        <button
          onClick={() => setShowSettings(true)}
          className="shrink-0 h-8 text-xs font-semibold text-charcoal border border-line rounded-[4px] px-3 hover:bg-subtle flex items-center gap-1.5"
        >
          <Icon name="Settings2" size={13} />
          {t("designer.settings")}
        </button>
      </div>

      <div className="flex-1 min-h-0 flex">
        {/* Process library rail — desktop only; phones use the add sheet */}
        <aside className="hidden lg:block w-60 shrink-0 border-r border-line bg-surface overflow-y-auto">
          <h3 className="text-[11px] font-bold uppercase text-muted px-3.5 pt-3.5 pb-1">{t("designer.processLibrary")}</h3>
          <p className="text-[11px] text-muted px-3.5 pb-2 leading-snug">
            {t(canEdit ? "designer.railHintEdit" : "designer.railHintView")}
          </p>
          <div className="px-2.5 pb-2 space-y-1.5">
            {processingProcs.map((t) => (
              <button
                key={t.id}
                disabled={!canEdit}
                onClick={() => handleAddStep(t.id)}
                className="w-full flex items-center gap-2 border border-line rounded-[4px] px-2.5 py-1.5 text-[12px] font-medium text-ink bg-surface hover:bg-subtle disabled:opacity-60 text-left"
              >
                <Icon name={t.icon} size={14} className="shrink-0 text-charcoal" />
                {tt(t.name)}
                {canEdit && <Icon name="Plus" size={12} className="ml-auto text-muted" />}
              </button>
            ))}
          </div>
          <div className="border-t border-line mt-1" />
          <h3 className="text-[11px] font-bold uppercase text-muted px-3.5 pt-3 pb-1">{t("designer.characterization")}</h3>
          <div className="px-2.5 pb-4 space-y-1.5">
            {charProcs.map((t) => (
              <button
                key={t.id}
                disabled={!canEdit}
                onClick={() => handleAddChar(t.id)}
                className="w-full flex items-center gap-2 border border-line rounded-[4px] px-2.5 py-1.5 text-[12px] font-medium text-ink bg-surface hover:bg-subtle disabled:opacity-60 text-left"
              >
                <Icon name={t.icon} size={14} className="shrink-0 text-charcoal" />
                {tt(t.name)}
                {canEdit && <Icon name="Plus" size={12} className="ml-auto text-muted" />}
              </button>
            ))}
          </div>
        </aside>

        {/* Canvas */}
        <section ref={canvasRef} className="flex-1 min-w-0 overflow-y-auto bg-subtle p-3 sm:p-5">
          {exp.status === "REVIEW" && (
            <ReviewPanel
              expId={exp.id}
              code={exp.code}
              assigneeName={orgUsers.find((u) => u.id === exp.assigneeId)?.name ?? "—"}
              submittedAt={exp.submittedAt ? new Date(exp.submittedAt).toISOString().replace("T", " ").slice(0, 16) : ""}
              submitNote={exp.submitNote}
              canApprove={canEdit}
            />
          )}
          <TeamStrip
            ownerName={exp.createdBy.name}
            assigneeId={exp.assigneeId}
            memberIds={exp.members.map((m) => m.userId)}
            orgUsers={orgUsers}
            expId={exp.id}
            canEdit={canManageMembers}
            onAddMember={handleAddMember}
            onRemoveMember={handleRemoveMember}
          />

          <ScienceStrip exp={exp} canEdit={canEdit} onSave={handleMeta} />

          <TestPlanCard
            plan={testPlan}
            processes={processes}
            equipment={equipment}
            materials={materials}
            layers={layers}
            categoryLayers={categoryLayers}
            sampleCount={exp.samples.length}
            canEdit={canEdit}
            onApply={handleApplyTestPlan}
          />

          <div className="flex items-center gap-2.5 mb-2.5 mt-5">
            <h2 className="text-[13px] font-bold shrink-0">{t("designer.processFlow")}</h2>
            <span className="text-[11px] text-muted hidden sm:inline">
              {t("designer.flowHint")}{canEdit && ` · ${t("designer.dragHint")}`}
            </span>
            {canEdit && (
              <button
                onClick={() => setAddSheet("step")}
                className="lg:hidden ml-auto h-8 shrink-0 flex items-center gap-1 px-2.5 text-[11.5px] font-bold text-brand-deep border border-brand/40 bg-brand-soft rounded-[4px]"
              >
                <Icon name="Plus" size={13} /> {t("designer.addStep")}
              </button>
            )}
          </div>
          <div className="grid grid-cols-1 xl:grid-cols-3 2xl:grid-cols-4 lg:grid-cols-2 gap-3">
            {orderedSteps.map((step) => (
              <StepCard
                key={step.id}
                step={step}
                selected={selection.kind === "step" && selection.id === step.id}
                canEdit={canEdit}
                onSelect={() => setSelection({ kind: "step", id: step.id })}
                onDelete={() => handleDeleteStep(step.id)}
                onDragStart={(e) => {
                  dragIdRef.current = step.id;
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (dragIdRef.current && dragIdRef.current !== step.id) setDropId(step.id);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  handleDrop(step.id);
                }}
                onHandleDown={startStepDrag(step.id)}
                layerName={layers.find((l) => l.code === step.layer)?.name}
                dropTarget={dropId === step.id}
              />
            ))}
            {exp.steps.length === 0 && (
              <div className="col-span-full border border-dashed border-line rounded-[6px] p-8 text-center text-sm text-muted bg-surface">
                {t("designer.emptySteps")}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2.5 mb-2.5 mt-6">
            <h2 className="text-[13px] font-bold shrink-0">{t("designer.charPlan")}</h2>
            <span className="text-[11px] text-muted hidden sm:inline">{t("designer.charHint")}</span>
            {canEdit && (
              <button
                onClick={() => setAddSheet("char")}
                className="lg:hidden ml-auto h-8 shrink-0 flex items-center gap-1 px-2.5 text-[11.5px] font-bold text-brand-deep border border-brand/40 bg-brand-soft rounded-[4px]"
              >
                <Icon name="Plus" size={13} /> {t("designer.addChar")}
              </button>
            )}
          </div>
          <div className="grid grid-cols-1 xl:grid-cols-3 2xl:grid-cols-4 lg:grid-cols-2 gap-3">
            {[...exp.characterizations]
              .sort((a, b) => a.position - b.position)
              .map((c) => (
                <CharCard
                  key={c.id}
                  char={c}
                  selected={selection.kind === "char" && selection.id === c.id}
                  canEdit={canEdit}
                  onSelect={() => setSelection({ kind: "char", id: c.id })}
                  onDelete={() => handleDeleteChar(c.id)}
                />
              ))}
            {exp.characterizations.length === 0 && (
              <div className="col-span-full border border-dashed border-line rounded-[6px] p-6 text-center text-sm text-muted bg-surface">
                {t("designer.emptyChars")}
              </div>
            )}
          </div>
        </section>

        {/* Inspector — side panel on desktop, bottom sheet on phones */}
        {(selectedStep || selectedChar) && (
          <div
            className="lg:hidden fixed inset-0 z-40 bg-ink/30"
            onClick={() => setSelection({ kind: "none" })}
          />
        )}
        <aside
          className={
            "bg-surface overflow-y-auto " +
            "lg:static lg:block lg:w-[360px] lg:shrink-0 lg:border-l lg:border-t-0 lg:border-line lg:rounded-none lg:shadow-none lg:max-h-none lg:z-auto " +
            (selectedStep || selectedChar
              ? "fixed inset-x-0 bottom-0 z-50 max-h-[80dvh] border-t border-line rounded-t-[10px] shadow-[0_-8px_30px_rgba(0,0,0,0.18)]"
              : "hidden")
          }
        >
          {(selectedStep || selectedChar) && (
            <div className="lg:hidden sticky top-0 z-10 flex items-center justify-between bg-surface border-b border-line px-3.5 py-2">
              <span className="text-[12px] font-bold truncate">
                {selectedStep?.name ?? selectedChar?.name}
              </span>
              <button
                onClick={() => setSelection({ kind: "none" })}
                className="p-1.5 -m-1 rounded-[4px] text-muted hover:bg-subtle"
              >
                <Icon name="X" size={16} />
              </button>
            </div>
          )}
          {selectedStep ? (
            <StepInspector
              key={selectedStep.id + String(selectedStep.parameters.map((p) => p.id).join(","))}
              step={selectedStep}
              groups={groups}
              equipment={equipment.filter((e) => e.processId === selectedStep.processId)}
              materials={materials}
              environments={environments}
              presets={presets.filter((p) => p.kind === "STEP" && p.processId === selectedStep.processId)}
              recipes={recipes}
              layers={layers}
              canManageMaterials={canManageMaterials}
              canEdit={canEdit}
              onSave={(draft, presetId) => handleSaveStep(selectedStep.id, draft, presetId)}
              onSavePreset={handleSaveStepPreset}
              onCreateMaterial={(name) => handleCreateMaterial(name, selectedStep.processId)}
            />
          ) : selectedChar ? (
            <CharInspector
              key={selectedChar.id}
              char={selectedChar}
              equipment={equipment.filter((e) => e.processId === selectedChar.processId)}
              environments={environments}
              presets={presets.filter((p) => p.kind === "CHARACTERIZATION" && p.processId === selectedChar.processId)}
              canEdit={canEdit}
              experimentId={exp.id}
              experimentCode={exp.code}
              onSave={(draft, presetId) => handleSaveChar(selectedChar.id, draft, presetId)}
              onSavePreset={handleSaveCharPreset}
            />
          ) : (
            <EmptyInspector canEdit={canEdit} />
          )}
        </aside>
      </div>

      {/* Status bar */}
      <footer className="h-7 shrink-0 flex items-center gap-4 px-4 border-t border-line bg-surface text-[11px] text-muted">
        <span className="flex items-center gap-1.5">
          <span
            className={
              "inline-block w-1.5 h-1.5 rounded-full " +
              (saveState === "saved" ? "bg-brand" : saveState === "saving" ? "bg-warn" : "bg-danger")
            }
          />
          {saveState === "saved" ? t("designer.saved") : saveState === "saving" ? t("designer.saving") : t("designer.saveFailed")}
        </span>
        <span className="mono">{exp.samples.length} {t("designer.samples")}</span>
        <span className="mono hidden sm:inline">{exp.steps.length} {t("designer.processSteps")}</span>
        <span className="mono hidden sm:inline">{exp.characterizations.length} {t("designer.characterizations")}</span>
        <span className="ml-auto hidden sm:inline">Pheno Lab Data Platform</span>
      </footer>

      {/* Mobile add sheet: pick a process to add a step / characterization */}
      {addSheet && (
        <>
          <div className="lg:hidden fixed inset-0 z-40 bg-ink/30" onClick={() => setAddSheet(null)} />
          <div className="lg:hidden fixed inset-x-0 bottom-0 z-50 bg-surface border-t border-line rounded-t-[10px] shadow-[0_-8px_30px_rgba(0,0,0,0.18)] max-h-[70dvh] overflow-y-auto">
            <div className="sticky top-0 bg-surface border-b border-line px-4 py-2.5 flex items-center justify-between">
              <span className="text-[12px] font-bold uppercase text-muted">
                {t(addSheet === "step" ? "designer.processLibrary" : "designer.characterization")}
              </span>
              <button onClick={() => setAddSheet(null)} className="p-1.5 -m-1 rounded-[4px] text-muted hover:bg-subtle">
                <Icon name="X" size={16} />
              </button>
            </div>
            <div className="p-3 space-y-1.5 pb-6">
              {(addSheet === "step" ? processingProcs : charProcs).map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    setAddSheet(null);
                    void (addSheet === "step" ? handleAddStep(p.id) : handleAddChar(p.id));
                  }}
                  className="w-full flex items-center gap-2.5 border border-line rounded-[5px] px-3 py-2.5 text-[13px] font-medium text-ink bg-surface active:bg-subtle text-left"
                >
                  <Icon name={p.icon} size={15} className="shrink-0 text-charcoal" />
                  {tt(p.name)}
                  <Icon name="Plus" size={13} className="ml-auto text-muted" />
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {showSettings && (
        <SettingsModal
          exp={exp}
          orgUsers={orgUsers}
          canEdit={canEdit}
          canManageMembers={canManageMembers}
          onClose={() => setShowSettings(false)}
          onMeta={handleMeta}
          onAddMember={handleAddMember}
          onRemoveMember={handleRemoveMember}
          onDelete={() => void deleteExperiment(exp.id)}
        />
      )}
    </div>
  );
}
