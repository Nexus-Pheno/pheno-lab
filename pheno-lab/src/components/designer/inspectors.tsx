"use client";

import { useMemo, useState } from "react";
import type { Equipment, Material, Preset, LabEnvironment } from "@prisma/client";
import type { StepFull, CharFull, StepDraft, CharDraft, ParamInput, MaterialInput } from "@/lib/types";
import { equipmentOptionLabel, paramDefs } from "@/lib/types";
import { Icon, FieldLabel, inputCls, selectCls } from "@/components/ui";
import { useT, useTerm } from "@/lib/i18n/LanguageProvider";
import { fuzzyFilter } from "@/lib/fuzzy";
import { JvFilesPanel } from "./JvFilesPanel";

// A characterization whose data the simulators push to us. Matches the same
// names the ingest matcher looks for, so the panel appears exactly where files
// can actually arrive.
const isJvCard = (char: CharFull) =>
  /j-?v|i-?v|current[-\s]?voltage|solar|效率|光电/i.test(char.name) ||
  /j-?v|i-?v|current[-\s]?voltage|solar|效率|光电/i.test(char.process?.name ?? "");


function InspectorShell({
  crumb,
  title,
  icon,
  children,
  footer,
}: {
  crumb: string;
  title: string;
  icon: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col min-h-full">
      <div className="px-4 pt-3.5 pb-2.5 border-b border-line">
        <div className="text-[10px] font-bold uppercase text-muted mb-0.5">{crumb}</div>
        <h3 className="text-[14px] font-bold flex items-center gap-2">
          <Icon name={icon} size={15} className="text-charcoal" />
          {title}
        </h3>
      </div>
      <div className="flex-1 px-4 py-3 space-y-3.5">{children}</div>
      {footer && <div className="px-4 py-3 border-t border-line sticky bottom-0 bg-surface">{footer}</div>}
    </div>
  );
}

function SaveFooter({
  dirty,
  onSave,
  onCancel,
  onSavePreset,
}: {
  dirty: boolean;
  onSave: () => void;
  onCancel: () => void;
  onSavePreset: () => void;
}) {
  const t = useT();
  return (
    <div>
      <div className="flex gap-2">
        <button
          onClick={onSave}
          disabled={!dirty}
          className="flex-1 bg-ink text-white rounded-[4px] py-2 text-[12px] font-bold disabled:opacity-40"
        >
          {t("insp.save")}
        </button>
        <button
          onClick={onCancel}
          disabled={!dirty}
          className="flex-1 border border-line rounded-[4px] py-2 text-[12px] font-semibold text-charcoal hover:bg-subtle disabled:opacity-40"
        >
          {t("insp.cancel")}
        </button>
      </div>
      <div className="flex justify-end mt-1.5">
        <button onClick={onSavePreset} className="text-[10.5px] font-semibold text-brand-deep hover:underline">
          {t("insp.saveAsPreset")}
        </button>
      </div>
    </div>
  );
}

function EnvironmentEditor({
  environments,
  environmentId,
  conditions,
  disabled,
  onChange,
}: {
  environments: LabEnvironment[];
  environmentId: string | null;
  conditions: Record<string, string>;
  disabled: boolean;
  onChange: (environmentId: string | null, conditions: Record<string, string>) => void;
}) {
  const t = useT();
  const active = environments.find((e) => e.id === environmentId);
  const defs = paramDefs(active?.conditions);

  return (
    <div>
      <FieldLabel>{t("insp.environment")}</FieldLabel>
      <select
        className={selectCls}
        disabled={disabled}
        value={environmentId ?? ""}
        onChange={(e) => {
          const env = environments.find((x) => x.id === e.target.value);
          if (!env) return onChange(null, {});
          const next: Record<string, string> = {};
          for (const d of paramDefs(env.conditions)) next[d.name] = conditions[d.name] ?? d.defaultValue;
          onChange(env.id, next);
        }}
      >
        <option value="">{t("insp.noEnvironment")}</option>
        {environments.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name}
          </option>
        ))}
      </select>
      {active && defs.length > 0 && (
        <div className="mt-1.5 border border-line rounded-[4px] divide-y divide-line">
          {defs.map((d) => (
            <div key={d.name} className="flex items-center gap-2 px-2.5 py-1.5">
              <span className="text-[12px] text-charcoal flex-1">{d.name}</span>
              <input
                className="mono w-24 border border-line rounded-[3px] px-2 py-1 text-[12px] text-right disabled:bg-subtle"
                value={conditions[d.name] ?? ""}
                disabled={disabled}
                onChange={(e) => onChange(environmentId, { ...conditions, [d.name]: e.target.value })}
              />
              <span className="text-[11px] text-muted w-12">{d.unit}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


// Fuzzy material search: type a name (even slightly off) and pick from the
// live suggestions. Creating new materials is reserved for material admins.
export function MaterialCombobox({
  materials,
  value,
  disabled,
  canCreate,
  onPick,
  onCreate,
}: {
  materials: Material[];
  value: string;
  disabled: boolean;
  canCreate: boolean;
  onPick: (id: string) => void;
  onCreate: (name: string) => void;
}) {
  const t = useT();
  const tt = useTerm();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const selected = materials.find((m) => m.id === value);
  const matches = fuzzyFilter(
    materials.filter((m) => !m.archived),
    query,
    (m) => `${m.name} ${m.composition} ${m.casNumber}`
  ).slice(0, 8);

  return (
    <div className="relative min-w-0">
      <input
        className="w-full border border-line rounded-[3px] px-2 py-1.5 text-[12px] bg-surface disabled:bg-subtle"
        disabled={disabled}
        placeholder={t("insp.searchMaterial")}
        value={open ? query : selected ? tt(selected.name) : ""}
        onFocus={() => { setQuery(""); setOpen(true); }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => setQuery(e.target.value)}
      />
      {open && (
        <div className="absolute z-30 left-0 right-0 top-full mt-0.5 bg-surface border border-line rounded-[4px] shadow-lg max-h-56 overflow-y-auto">
          {matches.map((m) => (
            <button
              key={m.id}
              onMouseDown={(e) => { e.preventDefault(); onPick(m.id); setOpen(false); }}
              className="w-full text-left px-2.5 py-1.5 hover:bg-subtle border-b border-line last:border-0"
            >
              <div className="text-[12px] font-medium truncate">{tt(m.name)}</div>
              <div className="mono text-[10px] text-muted truncate">
                {[m.composition.split("—")[0].trim(), t(`mat.cat.${m.category}` as "mat.cat.SAM")].filter(Boolean).join(" · ")}
              </div>
            </button>
          ))}
          {matches.length === 0 && (
            <p className="px-2.5 py-2 text-[11px] text-muted">{t("mat.noMatch")}</p>
          )}
          {canCreate && query.trim() && !matches.some((m) => m.name.toLowerCase() === query.trim().toLowerCase()) && (
            <button
              onMouseDown={(e) => { e.preventDefault(); onCreate(query.trim()); setOpen(false); }}
              className="w-full text-left px-2.5 py-1.5 text-[11.5px] font-semibold text-brand-deep hover:bg-subtle"
            >
              ＋ {t("insp.createMaterial")} “{query.trim()}”
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------- Step inspector ----------------

const stepToDraft = (step: StepFull): StepDraft => ({
  name: step.name,
  equipmentId: step.equipmentId,
  environmentId: step.environmentId,
  environmentConditions: (step.environmentConditions ?? {}) as Record<string, string>,
  recipeId: step.recipeId,
  layer: step.layer,
  notes: step.notes,
  materials: step.materials.map((m) => ({ materialId: m.materialId, amount: m.amount })),
  parameters: step.parameters.map((p) => ({
    name: p.name,
    unit: p.unit,
    value: p.value,
    source: p.source,
    variations: p.variations.map((v) => ({ variationGroup: v.variationGroup, value: v.value })),
  })),
});

export function StepInspector({
  step,
  groups,
  equipment,
  materials,
  environments,
  presets,
  recipes,
  layers,
  canManageMaterials,
  canEdit,
  onSave,
  onSavePreset,
  onCreateMaterial,
}: {
  step: StepFull;
  groups: string[];
  equipment: Equipment[];
  materials: Material[];
  environments: LabEnvironment[];
  presets: Preset[];
  recipes: { id: string; name: string; summary: string }[];
  layers: { code: string; name: string }[];
  canManageMaterials: boolean;
  canEdit: boolean;
  onSave: (draft: StepDraft, appliedPresetId: string | null) => void;
  onSavePreset: (name: string, draft: StepDraft) => void;
  onCreateMaterial: (name: string) => Promise<Material | null>;
}) {
  const t = useT();
  const [draft, setDraft] = useState<StepDraft>(() => stepToDraft(step));
  const [appliedPresetId, setAppliedPresetId] = useState<string | null>(null);
  const original = useMemo(() => JSON.stringify(stepToDraft(step)), [step]);
  const dirty = JSON.stringify(draft) !== original;

  const patch = (p: Partial<StepDraft>) => setDraft((d) => ({ ...d, ...p }));
  const patchParam = (i: number, p: Partial<ParamInput>) =>
    setDraft((d) => ({ ...d, parameters: d.parameters.map((x, j) => (j === i ? { ...x, ...p } : x)) }));
  const patchMaterial = (i: number, p: Partial<MaterialInput>) =>
    setDraft((d) => ({ ...d, materials: d.materials.map((x, j) => (j === i ? { ...x, ...p } : x)) }));

  const applyEquipment = (equipmentId: string | null) => {
    const eq = equipment.find((e) => e.id === equipmentId);
    if (!eq) return patch({ equipmentId });
    // The machine's WORK parameters (设备工艺参数) overlay the current set:
    // keep entered values for same-named parameters, tag machine-added ones
    // as "equipment". Spec-sheet values never flood the step.
    const defs = paramDefs(eq.workParameters);
    const params: ParamInput[] = defs.map((d) => {
      const existing = draft.parameters.find((p) => p.name.toLowerCase() === d.name.toLowerCase());
      return existing ?? { name: d.name, unit: d.unit, value: d.defaultValue, source: "equipment", variations: [] };
    });
    // Keep parameters that carry test-plan variations even if the machine
    // does not define them.
    for (const p of draft.parameters) {
      if (p.variations.length > 0 && !params.some((x) => x.name.toLowerCase() === p.name.toLowerCase())) {
        params.push(p);
      }
    }
    patch({ equipmentId, parameters: params.length > 0 ? params : draft.parameters });
  };

  const applyPreset = (preset: Preset) => {
    const p = preset.payload as unknown as {
      equipmentId: string | null; environmentId: string | null;
      environmentConditions: Record<string, string>;
      materials?: MaterialInput[];
      parameters: { name: string; unit: string; value: string; source?: string }[];
    };
    setDraft((d) => ({
      ...d,
      name: preset.name,
      equipmentId: p.equipmentId,
      environmentId: p.environmentId,
      environmentConditions: p.environmentConditions ?? {},
      materials: p.materials ?? [],
      parameters: (p.parameters ?? []).map((x) => ({ source: x.source ?? "process", ...x, variations: [] })),
    }));
    setAppliedPresetId(preset.id);
  };

  return (
    <InspectorShell
      crumb={`${t("insp.step")} ${String(step.position + 1).padStart(2, "0")} · ${step.process.name}`}
      title={draft.name}
      icon={step.process.icon}
      footer={
        canEdit ? (
          <SaveFooter
            dirty={dirty}
            onSave={() => onSave(draft, appliedPresetId)}
            onCancel={() => {
              setDraft(stepToDraft(step));
              setAppliedPresetId(null);
            }}
            onSavePreset={() => {
              const n = prompt(t("insp.presetNamePrompt"), draft.name);
              if (n) onSavePreset(n, draft);
            }}
          />
        ) : undefined
      }
    >
      {presets.length > 0 && canEdit && (
        <div>
          <FieldLabel>{t("insp.preset")}</FieldLabel>
          <select
            className={selectCls}
            value={appliedPresetId ?? ""}
            onChange={(e) => {
              const p = presets.find((x) => x.id === e.target.value);
              if (p) applyPreset(p);
              else setAppliedPresetId(null);
            }}
          >
            <option value="">{t("insp.applyPreset")}</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {t("insp.used")} {p.usageCount}×
              </option>
            ))}
          </select>
          {appliedPresetId && (
            <p className="text-[10px] text-brand-deep mt-1 flex items-center gap-1">
              <Icon name="Check" size={10} /> {t("insp.presetApplied")}
            </p>
          )}
        </div>
      )}

      <div>
        <FieldLabel>{t("insp.stepName")}</FieldLabel>
        <input className={inputCls} value={draft.name} disabled={!canEdit} onChange={(e) => patch({ name: e.target.value })} />
      </div>

      <div>
        <FieldLabel>{t("insp.equipment")}</FieldLabel>
        <select
          className={selectCls}
          disabled={!canEdit}
          value={draft.equipmentId ?? ""}
          onChange={(e) => applyEquipment(e.target.value || null)}
        >
          <option value="">{t("insp.noEquipment")}</option>
          {equipment.map((eq) => (
            <option key={eq.id} value={eq.id}>
              {equipmentOptionLabel(eq)}
              {eq.assetTag ? ` · ${eq.assetTag}` : ""}
            </option>
          ))}
        </select>
        <p className="text-[10px] text-muted mt-1">
          {equipment.length === 0
            ? t("insp.equipmentHintEmpty", { process: step.process.name })
            : t("insp.equipmentHint")}
        </p>
      </div>

      <div>
        <FieldLabel>{t("insp.parameters")}</FieldLabel>
        <div className="space-y-1.5">
          {draft.parameters.map((p, i) => (
            <div key={i} className="border border-line rounded-[4px] p-1.5">
              <div className="grid grid-cols-[1fr_72px_56px_auto] gap-1.5 items-center">
                <input
                  className="border border-line rounded-[3px] px-2 py-1 text-[12px] disabled:bg-subtle"
                  value={p.name}
                  placeholder={t("insp.parameter")}
                  disabled={!canEdit}
                  onChange={(e) => patchParam(i, { name: e.target.value })}
                />
                <input
                  className="mono border border-line rounded-[3px] px-2 py-1 text-[12px] disabled:bg-subtle"
                  value={p.value}
                  placeholder={t("insp.value")}
                  disabled={!canEdit || p.variations.length > 0}
                  onChange={(e) => patchParam(i, { value: e.target.value })}
                />
                <input
                  className="border border-line rounded-[3px] px-2 py-1 text-[12px] text-muted disabled:bg-subtle"
                  value={p.unit}
                  placeholder={t("insp.unit")}
                  disabled={!canEdit}
                  onChange={(e) => patchParam(i, { unit: e.target.value })}
                />
                {canEdit && (
                  <button
                    onClick={() => setDraft((d) => ({ ...d, parameters: d.parameters.filter((_, j) => j !== i) }))}
                    className="text-muted hover:text-danger p-0.5"
                    title="Remove parameter"
                  >
                    <Icon name="X" size={13} />
                  </button>
                )}
              </div>
              {groups.length > 0 && canEdit && (
                <div className="mt-1.5">
                  {p.variations.length === 0 ? (
                    <button
                      onClick={() =>
                        patchParam(i, { variations: groups.map((g) => ({ variationGroup: g, value: p.value })) })
                      }
                      className="text-[10px] font-semibold text-warn flex items-center gap-1"
                    >
                      <Icon name="Shuffle" size={10} /> {t("insp.vary")} {groups.join("/")}
                    </button>
                  ) : (
                    <div className="bg-brand-soft border border-brand/40 rounded-[3px] p-1.5">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[10px] font-bold text-brand-deep flex items-center gap-1">
                          <Icon name="Shuffle" size={10} /> {t("insp.varied")}
                        </span>
                        <button
                          onClick={() => patchParam(i, { variations: [] })}
                          className="text-[10px] text-muted hover:text-danger"
                        >
                          {t("insp.removeVariation")}
                        </button>
                      </div>
                      <div className="grid grid-cols-3 gap-1">
                        {groups.map((g) => {
                          const v = p.variations.find((x) => x.variationGroup === g);
                          return (
                            <label key={g} className="flex items-center gap-1 text-[11px]">
                              <span className="font-bold">{g}</span>
                              <input
                                className="mono w-full border border-brand/40 rounded-[3px] px-1.5 py-0.5 text-[11px] bg-surface"
                                value={v?.value ?? ""}
                                onChange={(e) =>
                                  patchParam(i, {
                                    variations: groups.map((gg) =>
                                      gg === g
                                        ? { variationGroup: gg, value: e.target.value }
                                        : p.variations.find((x) => x.variationGroup === gg) ?? { variationGroup: gg, value: "" }
                                    ),
                                  })
                                }
                              />
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
        {canEdit && (
          <button
            onClick={() =>
              setDraft((d) => ({
                ...d,
                parameters: [...d.parameters, { name: "", unit: "", value: "", source: "custom", variations: [] }],
              }))
            }
            className="mt-1.5 text-[11px] font-semibold text-brand-deep flex items-center gap-1"
          >
            <Icon name="Plus" size={11} /> {t("insp.addParameter")}
          </button>
        )}
      </div>

      <EnvironmentEditor
        environments={environments}
        environmentId={draft.environmentId}
        conditions={draft.environmentConditions}
        disabled={!canEdit}
        onChange={(environmentId, environmentConditions) => patch({ environmentId, environmentConditions })}
      />

      <div>
        <FieldLabel>{t("insp.materials")}</FieldLabel>
        <div className="space-y-1.5">
          {draft.materials.map((m, i) => (
            <div key={i} className="grid grid-cols-[1fr_96px_auto] gap-1.5 items-center">
              <MaterialCombobox
                materials={materials}
                value={m.materialId}
                disabled={!canEdit}
                canCreate={canManageMaterials}
                onPick={(id) => patchMaterial(i, { materialId: id })}
                onCreate={async (name) => {
                  const created = await onCreateMaterial(name);
                  if (created) patchMaterial(i, { materialId: created.id });
                }}
              />
              <input
                className="mono border border-line rounded-[3px] px-2 py-1.5 text-[12px] disabled:bg-subtle"
                placeholder={draft.materials.length > 1 ? t("insp.amountMixPh") : t("insp.amountPh")}
                title="Share of this material, e.g. mol% or wt%"
                disabled={!canEdit}
                value={m.amount}
                onChange={(e) => patchMaterial(i, { amount: e.target.value })}
              />
              {canEdit && (
                <button
                  onClick={() => setDraft((d) => ({ ...d, materials: d.materials.filter((_, j) => j !== i) }))}
                  className="text-muted hover:text-danger p-0.5"
                  title="Remove material"
                >
                  <Icon name="X" size={13} />
                </button>
              )}
            </div>
          ))}
          {draft.materials.length === 0 && (
            <p className="text-[11px] text-muted">{t("insp.noMaterial")}</p>
          )}
        </div>
        {canEdit && (
          <button
            onClick={() => setDraft((d) => ({ ...d, materials: [...d.materials, { materialId: "", amount: "" }] }))}
            className="mt-1.5 text-[11px] font-semibold text-brand-deep flex items-center gap-1"
          >
            <Icon name="Plus" size={11} /> {t("insp.addMaterial")}
          </button>
        )}
        {draft.materials.length > 1 && (
          <p className="text-[10px] text-muted mt-1">
            {t("insp.mixHint")}
          </p>
        )}
        <p className="text-[10px] text-muted mt-1">
          {t("insp.materialSearchHint")}
        </p>
      </div>

      <div>
        <FieldLabel>{t("insp.layer")}</FieldLabel>
        <select
          className="w-full border border-line rounded-[3px] px-2 py-1.5 text-[12px] bg-surface disabled:bg-subtle"
          disabled={!canEdit}
          value={draft.layer}
          onChange={(e) => patch({ layer: e.target.value })}
        >
          <option value="">{t("insp.noLayer")}</option>
          {layers.map((l) => (
            <option key={l.code} value={l.code}>{l.name}</option>
          ))}
        </select>
        <p className="text-[10px] text-muted mt-1">{t("insp.layerHint")}</p>
      </div>

      {draft.layer === "PEROVSKITE" && (
      <div>
        <FieldLabel>{t("insp.recipe")}</FieldLabel>
        <select
          className="w-full border border-line rounded-[3px] px-2 py-1.5 text-[12px] bg-surface disabled:bg-subtle"
          disabled={!canEdit}
          value={draft.recipeId ?? ""}
          onChange={(e) => patch({ recipeId: e.target.value || null })}
        >
          <option value="">{t("insp.noRecipe")}</option>
          {recipes.map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
        </select>
        {draft.recipeId && (
          <p className="text-[10px] text-muted mt-1">
            {recipes.find((r) => r.id === draft.recipeId)?.summary || t("insp.recipeHidden")}
          </p>
        )}
      </div>
      )}

      <div>
        <FieldLabel>{t("insp.notes")}</FieldLabel>
        <textarea
          className={inputCls + " resize-none"}
          rows={2}
          value={draft.notes}
          disabled={!canEdit}
          onChange={(e) => patch({ notes: e.target.value })}
        />
      </div>
    </InspectorShell>
  );
}

// ---------------- Characterization inspector ----------------

const charToDraft = (char: CharFull): CharDraft => ({
  name: char.name,
  equipmentId: char.equipmentId,
  environmentId: char.environmentId,
  environmentConditions: (char.environmentConditions ?? {}) as Record<string, string>,
  settings: (char.settings ?? {}) as Record<string, string>,
  sampleScope: char.sampleScope,
  notes: char.notes,
});

export function CharInspector({
  char,
  equipment,
  environments,
  presets,
  canEdit,
  experimentId,
  experimentCode,
  onSave,
  onSavePreset,
}: {
  char: CharFull;
  equipment: Equipment[];
  environments: LabEnvironment[];
  presets: Preset[];
  canEdit: boolean;
  experimentId: string;
  experimentCode: string;
  onSave: (draft: CharDraft, appliedPresetId: string | null) => void;
  onSavePreset: (name: string, draft: CharDraft) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState<CharDraft>(() => charToDraft(char));
  const [appliedPresetId, setAppliedPresetId] = useState<string | null>(null);
  const original = useMemo(() => JSON.stringify(charToDraft(char)), [char]);
  const dirty = JSON.stringify(draft) !== original;
  const settingsList = Object.entries(draft.settings);

  const patch = (p: Partial<CharDraft>) => setDraft((d) => ({ ...d, ...p }));

  const applyPreset = (preset: Preset) => {
    const p = preset.payload as unknown as {
      equipmentId: string | null; environmentId: string | null;
      environmentConditions: Record<string, string>; settings: Record<string, string>; sampleScope: string;
    };
    setDraft((d) => ({
      ...d,
      name: preset.name,
      equipmentId: p.equipmentId,
      environmentId: p.environmentId,
      environmentConditions: p.environmentConditions ?? {},
      settings: p.settings ?? {},
      sampleScope: p.sampleScope ?? "all",
    }));
    setAppliedPresetId(preset.id);
  };

  const setSettingAt = (i: number, key: string, value: string) => {
    const next = settingsList.map((kv, j) => (j === i ? [key, value] : kv));
    patch({ settings: Object.fromEntries(next.filter(([k]) => k !== "")) as Record<string, string> });
  };

  return (
    <InspectorShell
      crumb={`${t("insp.char")} · ${char.process.name}`}
      title={draft.name}
      icon={char.process.icon}
      footer={
        canEdit ? (
          <SaveFooter
            dirty={dirty}
            onSave={() => onSave(draft, appliedPresetId)}
            onCancel={() => {
              setDraft(charToDraft(char));
              setAppliedPresetId(null);
            }}
            onSavePreset={() => {
              const n = prompt(t("insp.presetNamePrompt"), draft.name);
              if (n) onSavePreset(n, draft);
            }}
          />
        ) : undefined
      }
    >
      {presets.length > 0 && canEdit && (
        <div>
          <FieldLabel>{t("insp.preset")}</FieldLabel>
          <select
            className={selectCls}
            value={appliedPresetId ?? ""}
            onChange={(e) => {
              const p = presets.find((x) => x.id === e.target.value);
              if (p) applyPreset(p);
              else setAppliedPresetId(null);
            }}
          >
            <option value="">{t("insp.applyPreset")}</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {t("insp.used")} {p.usageCount}×
              </option>
            ))}
          </select>
          {appliedPresetId && (
            <p className="text-[10px] text-brand-deep mt-1 flex items-center gap-1">
              <Icon name="Check" size={10} /> {t("insp.presetApplied")}
            </p>
          )}
        </div>
      )}

      <div>
        <FieldLabel>{t("insp.name")}</FieldLabel>
        <input className={inputCls} value={draft.name} disabled={!canEdit} onChange={(e) => patch({ name: e.target.value })} />
      </div>

      <div>
        <FieldLabel>{t("insp.instrument")}</FieldLabel>
        <select
          className={selectCls}
          disabled={!canEdit}
          value={draft.equipmentId ?? ""}
          onChange={(e) => patch({ equipmentId: e.target.value || null })}
        >
          <option value="">{t("insp.noInstrument")}</option>
          {equipment.map((eq) => (
            <option key={eq.id} value={eq.id}>
              {equipmentOptionLabel(eq)}
            </option>
          ))}
        </select>
      </div>

      <div>
        <FieldLabel>{t("insp.settings")}</FieldLabel>
        <div className="space-y-1.5">
          {settingsList.map(([k, v], i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-1.5 items-center">
              <input
                className="border border-line rounded-[3px] px-2 py-1 text-[12px] disabled:bg-subtle"
                value={k}
                placeholder={t("insp.setting")}
                disabled={!canEdit}
                onChange={(e) => setSettingAt(i, e.target.value, v)}
              />
              <input
                className="mono border border-line rounded-[3px] px-2 py-1 text-[12px] disabled:bg-subtle"
                value={v}
                placeholder={t("insp.value")}
                disabled={!canEdit}
                onChange={(e) => setSettingAt(i, k, e.target.value)}
              />
              {canEdit && (
                <button
                  onClick={() => patch({ settings: Object.fromEntries(settingsList.filter((_, j) => j !== i)) as Record<string, string> })}
                  className="text-muted hover:text-danger p-0.5"
                >
                  <Icon name="X" size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
        {canEdit && (
          <button
            onClick={() => patch({ settings: { ...draft.settings, [`Setting ${settingsList.length + 1}`]: "" } })}
            className="mt-1.5 text-[11px] font-semibold text-brand-deep flex items-center gap-1"
          >
            <Icon name="Plus" size={11} /> {t("insp.addSetting")}
          </button>
        )}
      </div>

      <EnvironmentEditor
        environments={environments}
        environmentId={draft.environmentId}
        conditions={draft.environmentConditions}
        disabled={!canEdit}
        onChange={(environmentId, environmentConditions) => patch({ environmentId, environmentConditions })}
      />

      <div>
        <FieldLabel>{t("insp.sampleScope")}</FieldLabel>
        <select
          className={selectCls}
          disabled={!canEdit}
          value={draft.sampleScope}
          onChange={(e) => patch({ sampleScope: e.target.value })}
        >
          <option value="all">{t("insp.allSamples")}</option>
          <option value="per-group">{t("insp.perGroup")}</option>
        </select>
      </div>

      <div>
        <FieldLabel>{t("insp.notes")}</FieldLabel>
        <textarea
          className={inputCls + " resize-none"}
          rows={2}
          value={draft.notes}
          disabled={!canEdit}
          onChange={(e) => patch({ notes: e.target.value })}
        />
      </div>

      {/* Instrument files, for the characterization that produces them. */}
      {isJvCard(char) && <JvFilesPanel experimentId={experimentId} experimentCode={experimentCode} />}
    </InspectorShell>
  );
}

// ---------------- Empty inspector (nothing selected) ----------------

export function EmptyInspector({ canEdit }: { canEdit: boolean }) {
  const t = useT();
  return (
    <div className="h-full flex flex-col items-center justify-center text-center px-8 gap-3">
      <Icon name="MousePointerClick" size={22} className="text-line" />
      <p className="text-[12.5px] text-muted leading-relaxed">
        {t("designer.selectHint")}
        {canEdit && " " + t("designer.selectHintEdit")}
      </p>
    </div>
  );
}
