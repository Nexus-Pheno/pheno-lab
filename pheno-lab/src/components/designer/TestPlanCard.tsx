"use client";

import { useState } from "react";
import type { Process, Equipment, Material } from "@prisma/client";
import type { TestPlan, TestPlanVariable } from "@/lib/library";
import { GROUP_LABELS } from "@/lib/library";
import { paramDefs } from "@/lib/types";
import { Icon, inputCls, selectCls, FieldLabel } from "@/components/ui";
import { SubstrateBoard, EXTRA_GROUP } from "@/components/designer/SubstrateBoard";
import { useT } from "@/lib/i18n/LanguageProvider";

const CUSTOM = "__custom__";

const distribute = (groups: { label: string; samples: number }[], count: number) => {
  const assignments: Record<string, string> = {};
  let n = 0;
  for (const g of groups) {
    for (let i = 0; i < g.samples && n < count; i++) assignments[`S${(n += 1)}`] = g.label;
  }
  while (n < count) assignments[`S${(n += 1)}`] = EXTRA_GROUP;
  return assignments;
};

const emptyPlan = (processId: string): TestPlan => {
  const groups = [
    { label: "A", samples: 3, isControl: true },
    { label: "B", samples: 3, isControl: false },
  ];
  return {
    groups,
    variables: [{ kind: "parameter", processId, equipmentId: "", layer: "", parameter: "", unit: "", values: {} }],
    substrates: { count: 8 },
    assignments: distribute(groups, 8),
  };
};

export function TestPlanCard({
  plan,
  processes,
  equipment,
  materials,
  layers,
  categoryLayers = [],
  sampleCount,
  canEdit,
  onApply,
}: {
  plan: TestPlan | null;
  processes: Process[];
  equipment: Equipment[];
  materials: Material[];
  layers: { code: string; name: string }[];
  categoryLayers?: { code: string; layers: string[] }[];
  sampleCount: number;
  canEdit: boolean;
  onApply: (plan: TestPlan) => Promise<void>;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<TestPlan | null>(null);
  const [busy, setBusy] = useState(false);

  const processing = processes.filter((p) => p.kind === "PROCESSING");
  const processName = (id: string) => processes.find((p) => p.id === id)?.name ?? "?";

  // Parameter suggestions for a process: its own definitions plus the
  // parameters of every machine under it.
  const paramOptions = (processId: string) => {
    const proc = processes.find((p) => p.id === processId);
    const defs = [...paramDefs(proc?.parameters)];
    for (const eq of equipment.filter((e) => e.processId === processId)) {
      for (const d of paramDefs(eq.parameters)) {
        if (!defs.some((x) => x.name.toLowerCase() === d.name.toLowerCase())) defs.push(d);
      }
    }
    return defs;
  };

  const materialsFor = (processId: string) => materials.filter((m) => m.processId === processId);
  // Materials are classified by use layer via their category (SAMs → HTL).
  // With a layer selected, the dropdown narrows to that layer's materials;
  // a layer no category claims falls back to the process's materials.
  const categoriesForLayer = (layer: string) =>
    categoryLayers.filter((c) => c.layers.includes(layer)).map((c) => c.code);
  const materialsForVariable = (v: TestPlanVariable) => {
    const cats = v.layer ? categoriesForLayer(v.layer) : [];
    if (cats.length > 0) {
      return materials.filter((m) => cats.includes((m as { category?: string }).category ?? ""));
    }
    return materialsFor(v.processId);
  };
  const substrateMaterials = (() => {
    const cats = categoriesForLayer("SUBSTRATE");
    return cats.length > 0
      ? materials.filter((m) => cats.includes((m as { category?: string }).category ?? ""))
      : materials;
  })();
  // The material slot name is derived, not typed: "<layer> Material".
  const autoSlotName = (layer?: string) => {
    if (!layer) return "Material";
    const plain = layerName(layer).replace(/\s*[（(].*?[)）]/g, "").trim();
    return `${plain} Material`;
  };
  const equipmentFor = (processId: string) => equipment.filter((e) => e.processId === processId && !e.archived);
  const layerName = (code?: string) => layers.find((l) => l.code === code)?.name ?? "";
  const equipmentName = (id?: string) => equipment.find((e) => e.id === id)?.name ?? "";
  // A new variable inherits the layer its process usually builds.
  const defaultLayerFor = (processId: string) =>
    (processes.find((p) => p.id === processId) as { defaultLayer?: string } | undefined)?.defaultLayer ?? "";

  const startEdit = () => {
    setDraft(
      plan
        ? {
            groups: plan.groups.map((g) => ({ ...g })),
            variables: plan.variables.map((v) => ({ ...v, values: { ...v.values } })),
            substrates: plan.substrates ? { ...plan.substrates } : undefined,
            assignments: plan.assignments ? { ...plan.assignments } : undefined,
          }
        : emptyPlan(processing[0]?.id ?? "")
    );
    setEditing(true);
  };

  const patchVar = (i: number, p: Partial<TestPlanVariable>) =>
    setDraft((d) => d && { ...d, variables: d.variables.map((v, j) => (j === i ? { ...v, ...p } : v)) });

  const setCell = (vi: number, group: string, value: string) =>
    setDraft((d) => d && {
      ...d,
      variables: d.variables.map((v, j) => (j === vi ? { ...v, values: { ...v.values, [group]: value } } : v)),
    });

  const total = draft?.groups.reduce((sum, g) => sum + (g.samples || 0), 0) ?? 0;

  // ---- display mode ----
  if (!editing) {
    return (
      <div className="mt-4 bg-surface border border-line rounded-[6px] px-3.5 py-3">
        <div className="flex items-center gap-3">
          <span className="text-[11px] font-bold uppercase text-muted flex items-center gap-1.5">
            <Icon name="TestTubes" size={13} /> {t("plan.title")}
          </span>
          {plan && plan.variables.length > 0 ? (
            <>
              <span className="text-[12px]">
                {t("plan.testing")}{" "}
                {plan.variables.map((v, i) => (
                  <span key={i}>
                    {i > 0 && " + "}
                    <span className="font-bold">{v.parameter}</span>
                    {v.unit && <span className="text-muted"> ({v.unit})</span>}
                    <span className="text-muted"> {t("plan.in")} </span>
                    <span className="font-semibold">{processName(v.processId)}</span>
                    {v.layer && (
                      <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-[3px] bg-ink/5 border border-ink/15 text-charcoal">
                        {layerName(v.layer)}
                      </span>
                    )}
                    {v.equipmentId && (
                      <span className="ml-1 mono text-[10px] text-muted">{equipmentName(v.equipmentId)}</span>
                    )}
                  </span>
                ))}
              </span>
              <span className="mono text-[12px] text-charcoal">{sampleCount} {t("plan.samples")}</span>
            </>
          ) : (
            <span className="text-[12px] text-muted">{t("plan.none")}</span>
          )}
          <div className="flex-1" />
          {canEdit && (
            <button onClick={startEdit} className="text-[11px] font-semibold text-brand-deep hover:underline">
              {plan ? t("plan.edit") : t("plan.define")}
            </button>
          )}
        </div>
        {plan && plan.variables.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {plan.groups.map((g) => (
              <span
                key={g.label}
                className={
                  "text-[11px] px-2 py-0.5 rounded-[3px] border font-medium " +
                  (g.isControl ? "bg-subtle text-charcoal border-line" : "bg-brand-soft text-brand-deep border-brand/40")
                }
              >
                {g.label}
                {g.isControl && ` (${t("plan.controlWord")})`}: {plan.variables.map((v) => `${v.values[g.label] ?? "—"}${v.unit ? " " + v.unit : ""}`).join(" · ")} · {g.samples}×
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ---- edit mode ----
  if (!draft) return null;
  return (
    <div className="mt-4 bg-surface border-2 border-brand-deep rounded-[6px] px-3.5 py-3 space-y-3.5">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-bold uppercase text-muted flex items-center gap-1.5">
          <Icon name="TestTubes" size={13} /> {t("plan.title")}
        </span>
        <span className="text-[11px] text-muted">
          {t("plan.question")}
        </span>
      </div>

      {/* Variables */}
      <div className="space-y-2">
        {draft.variables.map((v, vi) => {
          const options = paramOptions(v.processId);
          const known = options.some((o) => o.name === v.parameter);
          return (
            <div key={vi} className="border border-line rounded-[4px] p-2.5 bg-subtle/60">
              <div className="flex flex-wrap gap-2.5 items-end">
                <div className="w-40">
                  <FieldLabel>{t("plan.variable")} {vi + 1} — {t("plan.variableType")}</FieldLabel>
                  <select
                    className={selectCls}
                    value={v.kind}
                    onChange={(e) => patchVar(vi, { kind: e.target.value as "parameter" | "material", parameter: e.target.value === "material" ? "Material" : "", unit: "", values: {} })}
                  >
                    <option value="parameter">{t("plan.parameterKind")}</option>
                    <option value="material">{t("plan.materialKind")}</option>
                  </select>
                </div>
                <div className="flex-1 min-w-44">
                  <FieldLabel>{t("plan.process")}</FieldLabel>
                  <select
                    className={selectCls}
                    value={v.processId}
                    onChange={(e) => {
                      // Changing the process resets the parameter so the right
                      // options populate for the new process.
                      patchVar(vi, {
                        processId: e.target.value,
                        equipmentId: "",
                        layer: defaultLayerFor(e.target.value),
                        parameter:
                          v.kind === "material"
                            ? autoSlotName(defaultLayerFor(e.target.value))
                            : "",
                        unit: "",
                        values: {},
                      });
                    }}
                  >
                    {processing.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
                <div className="flex-1 min-w-40">
                  <FieldLabel>{t("plan.equipment")}</FieldLabel>
                  <select
                    className={selectCls}
                    value={v.equipmentId ?? ""}
                    onChange={(e) => patchVar(vi, { equipmentId: e.target.value })}
                  >
                    <option value="">{t("plan.anyEquipment")}</option>
                    {equipmentFor(v.processId).map((e) => (
                      <option key={e.id} value={e.id}>{e.nickname ? `${e.nickname} — ${e.name}` : e.name}</option>
                    ))}
                  </select>
                </div>
                <div className="flex-1 min-w-36">
                  <FieldLabel>{t("plan.layer")}</FieldLabel>
                  <select
                    className={selectCls}
                    value={v.layer ?? ""}
                    onChange={(e) =>
                      patchVar(vi, {
                        layer: e.target.value,
                        ...(v.kind === "material"
                          ? { parameter: autoSlotName(e.target.value) }
                          : {}),
                      })
                    }
                  >
                    <option value="">{t("plan.noLayer")}</option>
                    {layers.map((l) => (
                      <option key={l.code} value={l.code}>{l.name}</option>
                    ))}
                  </select>
                </div>
                {v.kind === "parameter" ? (
                  <>
                    <div className="flex-1 min-w-44">
                      <FieldLabel>{t("plan.parameterTested")}</FieldLabel>
                      <select
                        className={selectCls}
                        value={known ? v.parameter : v.parameter ? CUSTOM : ""}
                        onChange={(e) => {
                          if (e.target.value === CUSTOM) {
                            const name = prompt(t("plan.customParameter"));
                            if (name?.trim()) patchVar(vi, { parameter: name.trim() });
                            return;
                          }
                          const def = options.find((o) => o.name === e.target.value);
                          patchVar(vi, { parameter: e.target.value, unit: def?.unit ?? v.unit });
                        }}
                      >
                        <option value="">{t("plan.selectParameter")}</option>
                        {options.map((o) => (
                          <option key={o.name} value={o.name}>
                            {o.name}{o.unit ? ` (${o.unit})` : ""}
                          </option>
                        ))}
                        {!known && v.parameter && <option value={CUSTOM}>{v.parameter} (custom)</option>}
                        <option value={CUSTOM}>{t("plan.customParameter")}</option>
                      </select>
                    </div>
                    <div className="w-20">
                      <FieldLabel>{t("plan.unit")}</FieldLabel>
                      <input className={inputCls} value={v.unit} placeholder="°C" onChange={(e) => patchVar(vi, { unit: e.target.value })} />
                    </div>
                  </>
                ) : (
                  <div className="flex-1 min-w-44">
                    <FieldLabel>{t("plan.materialSlot")}</FieldLabel>
                    <div className="border border-line rounded-[3px] px-2 py-1.5 text-[12px] bg-subtle text-charcoal">
                      {v.parameter || autoSlotName(v.layer)}
                    </div>
                  </div>
                )}
                {draft.variables.length > 1 && (
                  <button
                    onClick={() => setDraft({ ...draft, variables: draft.variables.filter((_, j) => j !== vi) })}
                    className="text-muted hover:text-danger p-1 mb-1"
                    title="Remove variable"
                  >
                    <Icon name="X" size={14} />
                  </button>
                )}
              </div>
            </div>
          );
        })}
        <button
          onClick={() =>
            setDraft({
              ...draft,
              variables: [...draft.variables, {
                kind: "parameter",
                processId: processing[0]?.id ?? "",
                equipmentId: "",
                layer: defaultLayerFor(processing[0]?.id ?? ""),
                parameter: "", unit: "", values: {},
              }],
            })
          }
          className="text-[11px] font-semibold text-brand-deep flex items-center gap-1"
        >
          <Icon name="Plus" size={11} /> {t("plan.addVariable")}
        </button>
      </div>

      {/* Substrate batch: size, material, drag-drop group membership */}
      <div className="border border-line rounded-[6px] p-2.5 space-y-2">
        <div className="flex flex-wrap items-end gap-3">
          <span className="text-[11px] font-bold">{t("plan.substrates")}</span>
          <div>
            <FieldLabel>{t("plan.substrateCount")}</FieldLabel>
            <input
              type="number" min={1} max={99}
              className="mono w-20 border border-line rounded-[3px] px-2 py-1.5"
              value={draft.substrates?.count ?? draft.groups.reduce((a, g) => a + g.samples, 0)}
              onChange={(e) => {
                const count = Math.min(99, Math.max(1, Number(e.target.value) || 1));
                const assignments: Record<string, string> = {};
                for (let i = 1; i <= count; i++) {
                  assignments[`S${i}`] = draft.assignments?.[`S${i}`] ?? EXTRA_GROUP;
                }
                setDraft({ ...draft, substrates: { ...draft.substrates, count }, assignments });
              }}
            />
          </div>
          <div className="flex-1 min-w-40">
            <FieldLabel>{t("plan.substrateMaterial")}</FieldLabel>
            <select
              className={selectCls}
              value={draft.substrates?.materialName ?? ""}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  substrates: { count: draft.substrates?.count ?? draft.groups.reduce((a, g) => a + g.samples, 0), materialName: e.target.value },
                })
              }
            >
              <option value="">{t("plan.selectMaterial")}</option>
              {substrateMaterials.map((m) => (
                <option key={m.id} value={m.name}>{m.name}</option>
              ))}
              {draft.substrates?.materialName &&
                !substrateMaterials.some((m) => m.name === draft.substrates?.materialName) && (
                  <option value={draft.substrates.materialName}>{draft.substrates.materialName}</option>
                )}
            </select>
          </div>
        </div>
        {draft.substrates && draft.assignments ? (
          <>
            <p className="text-[10px] text-muted">{t("plan.substrateHint")}</p>
            <SubstrateBoard
              groups={draft.groups.map((g) => g.label)}
              assignments={draft.assignments}
              onMove={(sample, zone) =>
                setDraft((d) => d && { ...d, assignments: { ...d.assignments, [sample]: zone } })
              }
            />
          </>
        ) : (
          <button
            className="text-[11px] text-brand-deep font-semibold flex items-center gap-1"
            onClick={() => {
              const count = draft.groups.reduce((a, g) => a + g.samples, 0);
              setDraft({ ...draft, substrates: { count }, assignments: distribute(draft.groups, count) });
            }}
          >
            <Icon name="Grid3x3" size={11} /> {t("plan.substrates")}
          </button>
        )}
      </div>

      {/* Groups x variables matrix */}
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-[10px] font-bold uppercase text-muted text-left">
              <th className="pb-1 pr-2 w-12">{t("plan.group")}</th>
              <th className="pb-1 pr-2 w-20">{t("plan.samples")}</th>
              <th className="pb-1 pr-2 w-20">{t("plan.control")}</th>
              {draft.variables.map((v, vi) => (
                <th key={vi} className="pb-1 pr-2">
                  {v.parameter || `${t("plan.variable")} ${vi + 1}`}{v.unit ? ` (${v.unit})` : ""}
                </th>
              ))}
              <th className="pb-1 w-8" />
            </tr>
          </thead>
          <tbody>
            {draft.groups.map((g, gi) => (
              <tr key={gi}>
                <td className="py-1 pr-2 mono font-bold">{g.label}</td>
                <td className="py-1 pr-2">
                  <input
                    type="number" min={1} max={48}
                    className="mono w-16 border border-line rounded-[3px] px-2 py-1.5"
                    value={g.samples}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        groups: draft.groups.map((x, j) => (j === gi ? { ...x, samples: Math.max(1, Number(e.target.value) || 1) } : x)),
                      })
                    }
                  />
                </td>
                <td className="py-1 pr-2">
                  <input
                    type="radio"
                    name="control-group"
                    checked={g.isControl}
                    onChange={() =>
                      setDraft({ ...draft, groups: draft.groups.map((x, j) => ({ ...x, isControl: j === gi })) })
                    }
                  />
                </td>
                {draft.variables.map((v, vi) => (
                  <td key={vi} className="py-1 pr-2">
                    {v.kind === "material" ? (
                      <select
                        className="w-full border border-line rounded-[3px] px-2 py-1.5 bg-surface"
                        value={v.values[g.label] ?? ""}
                        onChange={(e) => setCell(vi, g.label, e.target.value)}
                      >
                        <option value="">{t("plan.selectMaterial")}</option>
                        {materialsForVariable(v).map((m) => (
                          <option key={m.id} value={m.name}>{m.name}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        className="mono w-full border border-line rounded-[3px] px-2 py-1.5"
                        placeholder="value"
                        value={v.values[g.label] ?? ""}
                        onChange={(e) => setCell(vi, g.label, e.target.value)}
                      />
                    )}
                  </td>
                ))}
                <td className="py-1">
                  <button
                    onClick={() =>
                      setDraft({
                        ...draft,
                        groups: draft.groups.filter((_, j) => j !== gi).map((x, j) => ({ ...x, label: GROUP_LABELS[j] })),
                        assignments: draft.assignments
                          ? Object.fromEntries(
                              Object.entries(draft.assignments).map(([code, zone]) => {
                                const oldIndex = draft.groups.findIndex((x) => x.label === zone);
                                if (oldIndex === -1) return [code, zone];
                                if (oldIndex === gi) return [code, EXTRA_GROUP];
                                return [code, GROUP_LABELS[oldIndex > gi ? oldIndex - 1 : oldIndex]];
                              }),
                            )
                          : draft.assignments,
                      })
                    }
                    disabled={draft.groups.length <= 1}
                    className="text-muted hover:text-danger p-0.5 disabled:opacity-30"
                  >
                    <Icon name="X" size={13} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex items-center justify-between mt-2">
          <button
            onClick={() =>
              draft.groups.length < GROUP_LABELS.length &&
              setDraft({
                ...draft,
                groups: [...draft.groups, { label: GROUP_LABELS[draft.groups.length], samples: 3, isControl: false }],
              })
            }
            className="text-[11px] font-semibold text-brand-deep flex items-center gap-1"
          >
            <Icon name="Plus" size={11} /> {t("plan.addGroup")}
          </button>
          <span className="text-[12px]">
            {t("plan.total")} <span className="mono font-bold">{total}</span>
            <span className="text-muted"> {t("plan.autoCalc")}</span>
          </span>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 justify-end items-center">
        <span className="text-[10.5px] text-muted mr-auto max-w-lg">
          {t("plan.applyNote")}
        </span>
        <button
          onClick={() => setEditing(false)}
          className="h-8 shrink-0 whitespace-nowrap border border-line rounded-[4px] px-3.5 text-[12px] font-semibold hover:bg-subtle"
        >
          {t("plan.cancel")}
        </button>
        <button
          disabled={
            busy ||
            draft.variables.some((v) => !v.parameter.trim() || !v.processId) ||
            draft.variables.some((v) => draft.groups.some((g) => !(v.values[g.label] ?? "").trim()))
          }
          onClick={async () => {
            setBusy(true);
            const toApply =
              draft.substrates && draft.assignments
                ? {
                    ...draft,
                    groups: draft.groups.map((g) => ({
                      ...g,
                      samples: Math.max(
                        1,
                        Object.values(draft.assignments ?? {}).filter((z) => z === g.label).length,
                      ),
                    })),
                  }
                : draft;
            await onApply(toApply);
            setBusy(false);
            setEditing(false);
          }}
          className="h-8 shrink-0 whitespace-nowrap bg-ink text-white rounded-[4px] px-4 text-[12px] font-bold disabled:opacity-50"
        >
          {t("plan.apply")}
        </button>
      </div>
    </div>
  );
}
