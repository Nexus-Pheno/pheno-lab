"use client";
import { useState } from "react";
import type { PresetRow } from "@/modules/experiments/preset-policy";
import type { StepPresetPayload, CharPresetPayload } from "@/lib/types";
import { useT } from "@/lib/i18n/LanguageProvider";
import { inputCls, selectCls } from "@/components/ui";

export type PresetEditorCatalog = {
  processes: { id: string; name: string }[];
  equipment: { id: string; name: string; processId: string }[];
  environments: { id: string; name: string }[];
  materials: { id: string; name: string }[];
};
type Payload = StepPresetPayload & CharPresetPayload;
export function PresetSummary({
  kind,
  payload,
  catalog,
}: {
  kind: "STEP" | "CHARACTERIZATION";
  payload: unknown;
  catalog: PresetEditorCatalog;
}) {
  const t = useT();
  const p = payload as Payload;
  const entries = [
    [
      t("insp.equipment"),
      catalog.equipment.find((e) => e.id === p.equipmentId)?.name ?? "—",
    ],
    [
      t("presets.environment"),
      catalog.environments.find((e) => e.id === p.environmentId)?.name ?? "—",
    ],
    ...Object.entries(p.environmentConditions ?? {}),
    ...(kind === "STEP"
      ? (p.parameters ?? []).map((v) => [v.name, `${v.value} ${v.unit}`])
      : Object.entries(p.settings ?? {})),
    ...(kind === "STEP"
      ? (p.materials ?? []).map((v) => [
          catalog.materials.find((m) => m.id === v.materialId)?.name ?? "—",
          v.amount,
        ])
      : [[t("presets.sampleScope"), p.sampleScope ?? ""]]),
  ];
  return (
    <dl className="text-xs space-y-2 [overflow-wrap:anywhere]">
      {entries.map(([key, value], i) => (
        <div key={i}>
          <dt className="font-semibold">{key}</dt>
          <dd className="whitespace-pre-wrap">{value || "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

export function PresetEditor({
  preset,
  catalog,
  busy,
  onSave,
  onCancel,
}: {
  preset: PresetRow;
  catalog: PresetEditorCatalog;
  busy: boolean;
  onSave: (
    name: string,
    payload: StepPresetPayload | CharPresetPayload,
  ) => Promise<boolean>;
  onCancel: () => void;
}) {
  const t = useT();
  const p = preset.payload as unknown as Payload;
  const [name, setName] = useState(preset.name);
  const [equipmentId, setEquipment] = useState(p.equipmentId ?? "");
  const [environmentId, setEnvironment] = useState(p.environmentId ?? "");
  const [conditions, setConditions] = useState<[string, string][]>(
    Object.entries(p.environmentConditions ?? {}),
  );
  const [settings, setSettings] = useState<[string, string][]>(
    Object.entries(p.settings ?? {}),
  );
  const [scope, setScope] = useState(p.sampleScope ?? "all");
  const [parameters, setParameters] = useState(p.parameters ?? []);
  const [materials, setMaterials] = useState(p.materials ?? []);
  const [invalid, setInvalid] = useState(false);
  const invalidNames = [conditions, settings].some(
    (rows) =>
      rows.some(([key]) => !key.trim()) ||
      new Set(rows.map(([key]) => key)).size !== rows.length,
  );
  const keyValues = (
    rows: [string, string][],
    setRows: (rows: [string, string][]) => void,
    label: string,
  ) => (
    <fieldset className="space-y-2">
      <legend className="text-xs font-bold">{label}</legend>
      {rows.map(([key, value], i) => (
        <div
          key={i}
          className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2"
        >
          <input
            aria-label={`${label} ${t("presets.key")} ${i + 1}`}
            className={inputCls}
            value={key}
            maxLength={200}
            onChange={(e) =>
              setRows(
                rows.map((v, j) => (j === i ? [e.target.value, v[1]] : v)),
              )
            }
          />
          <input
            aria-label={`${label} ${t("presets.value")} ${i + 1}`}
            className={inputCls}
            value={value}
            maxLength={20000}
            onChange={(e) =>
              setRows(
                rows.map((v, j) => (j === i ? [v[0], e.target.value] : v)),
              )
            }
          />
          <button
            type="button"
            onClick={() => setRows(rows.filter((_, j) => j !== i))}
            aria-label={`${t("presets.removeRow")} ${i + 1}`}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        disabled={rows.length >= 500}
        className="text-xs text-brand-deep"
        onClick={() => setRows([...rows, ["", ""]])}
      >
        {t("presets.addRow")}
      </button>
    </fieldset>
  );
  return (
    <form
      className="border-t border-line pt-3 space-y-4"
      onSubmit={async (event) => {
        event.preventDefault();
        if (invalidNames) {
          setInvalid(true);
          return;
        }
        const shared = {
          equipmentId: equipmentId || null,
          environmentId: environmentId || null,
          environmentConditions: Object.fromEntries(conditions),
        };
        const payload =
          preset.kind === "STEP"
            ? { ...shared, parameters, materials }
            : {
                ...shared,
                settings: Object.fromEntries(settings),
                sampleScope: scope,
              };
        await onSave(name, payload);
      }}
    >
      <label className="block text-xs">
        {t("lib.presetName")}
        <input
          className={inputCls}
          required
          maxLength={500}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="text-xs">
          {t("insp.equipment")}
          <select
            className={selectCls}
            value={equipmentId}
            onChange={(e) => setEquipment(e.target.value)}
          >
            <option value="">—</option>
            {catalog.equipment
              .filter((e) => e.processId === preset.processId)
              .map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
          </select>
        </label>
        <label className="text-xs">
          {t("presets.environment")}
          <select
            className={selectCls}
            value={environmentId}
            onChange={(e) => setEnvironment(e.target.value)}
          >
            <option value="">—</option>
            {catalog.environments.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {keyValues(conditions, setConditions, t("presets.conditions"))}
      {preset.kind === "STEP" ? (
        <>
          <fieldset className="space-y-2">
            <legend className="text-xs font-bold">
              {t("lib.paramValues")}
            </legend>
            {parameters.map((param, i) => (
              <div
                key={i}
                className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.5fr)_auto] gap-2"
              >
                <input
                  aria-label={`${t("presets.parameterName")} ${i + 1}`}
                  className={inputCls}
                  required
                  maxLength={200}
                  value={param.name}
                  onChange={(e) =>
                    setParameters(
                      parameters.map((v, j) =>
                        j === i ? { ...v, name: e.target.value } : v,
                      ),
                    )
                  }
                />
                <input
                  aria-label={`${t("presets.value")} ${i + 1}`}
                  className={inputCls}
                  maxLength={4000}
                  value={param.value}
                  onChange={(e) =>
                    setParameters(
                      parameters.map((v, j) =>
                        j === i ? { ...v, value: e.target.value } : v,
                      ),
                    )
                  }
                />
                <input
                  aria-label={`${t("presets.unit")} ${i + 1}`}
                  className={inputCls}
                  maxLength={100}
                  value={param.unit}
                  onChange={(e) =>
                    setParameters(
                      parameters.map((v, j) =>
                        j === i ? { ...v, unit: e.target.value } : v,
                      ),
                    )
                  }
                />
                <button
                  type="button"
                  aria-label={`${t("presets.removeRow")} ${i + 1}`}
                  onClick={() =>
                    setParameters(parameters.filter((_, j) => j !== i))
                  }
                >
                  ×
                </button>
              </div>
            ))}
            <button
              type="button"
              disabled={parameters.length >= 500}
              className="text-xs text-brand-deep"
              onClick={() =>
                setParameters([
                  ...parameters,
                  { name: "", value: "", unit: "", source: "custom" },
                ])
              }
            >
              {t("presets.addRow")}
            </button>
          </fieldset>
          <fieldset className="space-y-2">
            <legend className="text-xs font-bold">
              {t("presets.materials")}
            </legend>
            {materials.map((material, i) => (
              <div
                key={i}
                className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2"
              >
                <select
                  aria-label={`${t("presets.materials")} ${i + 1}`}
                  required
                  className={selectCls}
                  value={material.materialId}
                  onChange={(e) =>
                    setMaterials(
                      materials.map((v, j) =>
                        j === i ? { ...v, materialId: e.target.value } : v,
                      ),
                    )
                  }
                >
                  <option value="">—</option>
                  {catalog.materials.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
                <input
                  aria-label={`${t("presets.amount")} ${i + 1}`}
                  className={inputCls}
                  maxLength={500}
                  value={material.amount}
                  onChange={(e) =>
                    setMaterials(
                      materials.map((v, j) =>
                        j === i ? { ...v, amount: e.target.value } : v,
                      ),
                    )
                  }
                />
                <button
                  type="button"
                  aria-label={`${t("presets.removeRow")} ${i + 1}`}
                  onClick={() =>
                    setMaterials(materials.filter((_, j) => j !== i))
                  }
                >
                  ×
                </button>
              </div>
            ))}
            <button
              type="button"
              disabled={materials.length >= 500}
              className="text-xs text-brand-deep"
              onClick={() =>
                setMaterials([...materials, { materialId: "", amount: "" }])
              }
            >
              {t("presets.addRow")}
            </button>
          </fieldset>
        </>
      ) : (
        <>
          {keyValues(settings, setSettings, t("lib.presetSettings"))}
          <label className="block text-xs">
            {t("presets.sampleScope")}
            <input
              className={inputCls}
              maxLength={200}
              value={scope}
              onChange={(e) => setScope(e.target.value)}
            />
          </label>
        </>
      )}
      {invalid && invalidNames && (
        <p role="alert" className="text-sm text-danger">
          {t("presets.invalidSettingNames")}
        </p>
      )}
      <div className="flex gap-3 justify-end">
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="text-sm border border-line rounded px-3 py-2"
        >
          {t("lib.cancel")}
        </button>
        <button
          type="submit"
          disabled={busy || !name.trim()}
          className="text-sm bg-ink text-white rounded px-3 py-2 disabled:opacity-50"
        >
          {t("lib.saveChanges")}
        </button>
      </div>
    </form>
  );
}
