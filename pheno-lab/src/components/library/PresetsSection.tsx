"use client";

import { useState } from "react";
import type { Preset } from "@prisma/client";
import { updatePreset, deletePreset } from "@/lib/actions/experiments";
import type { StepPresetPayload, CharPresetPayload } from "@/lib/types";
import { Icon, FieldLabel, inputCls } from "@/components/ui";
import { useT } from "@/lib/i18n/LanguageProvider";
import { LibrarySection } from "./Collapsible";

type PresetRow = Preset & { createdBy: { name: string } | null; process: { name: string } };

export function PresetsSection({
  presets,
  sessionUid,
  sessionRole,
}: {
  presets: PresetRow[];
  sessionUid: string;
  sessionRole: string;
}) {
  const t = useT();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  // Admin and managers edit all presets; technicians only their own.
  const canEditPreset = (p: PresetRow) =>
    sessionRole === "ADMIN" || sessionRole === "MANAGER" || p.createdById === sessionUid;

  return (
    <LibrarySection
      title={t("lib.presets")}
      subtitle={t("lib.presetsHint")}
      icon="Bookmark"
      count={presets.length}
    >
      <div className="bg-surface border border-line rounded-[6px] overflow-hidden">
        {presets.map((p) => (
          <div key={p.id} className="border-b border-line last:border-0">
            <div
              className="flex items-center gap-3 px-3.5 py-2.5 hover:bg-subtle cursor-pointer"
              onClick={() => canEditPreset(p) && setEditingId(editingId === p.id ? null : p.id)}
            >
              <span className="text-[12.5px] font-medium flex-1">{p.name}</span>
              <span className="text-[11px] text-muted w-32">{t(p.kind === "STEP" ? "lib.stepKind" : "lib.charKind")}</span>
              <span className="text-[11px] text-muted w-40">{p.process.name}</span>
              <span className="mono text-[11px] text-muted w-10 text-right">{p.usageCount}×</span>
              <span className="text-[11px] text-muted w-24">{p.createdBy?.name ?? "—"}</span>
              {canEditPreset(p) ? (
                confirmingId === p.id ? (
                  <span className="flex items-center gap-1.5 text-[11px]" onClick={(e) => e.stopPropagation()}>
                    <span className="font-semibold text-warn">{t("card.deleteQ")}</span>
                    <button onClick={() => deletePreset(p.id)} className="text-danger font-bold">Yes</button>
                    <button onClick={() => setConfirmingId(null)} className="text-muted">No</button>
                  </span>
                ) : (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmingId(p.id);
                    }}
                    className="text-muted hover:text-danger p-0.5"
                    title="Delete preset"
                  >
                    <Icon name="Trash2" size={13} />
                  </button>
                )
              ) : (
                <span className="w-5" />
              )}
            </div>
            {editingId === p.id && (
              <PresetEditor preset={p} onDone={() => setEditingId(null)} />
            )}
          </div>
        ))}
        {presets.length === 0 && (
          <p className="px-4 py-6 text-center text-muted text-sm">
            {t("lib.noPresets")}
          </p>
        )}
      </div>
    </LibrarySection>
  );
}

function PresetEditor({ preset, onDone }: { preset: PresetRow; onDone: () => void }) {
  const t = useT();
  const [name, setName] = useState(preset.name);
  const isStep = preset.kind === "STEP";
  const payload = preset.payload as unknown as StepPresetPayload & CharPresetPayload;
  const [params, setParams] = useState(isStep ? (payload.parameters ?? []) : []);
  const [settings, setSettings] = useState<[string, string][]>(
    isStep ? [] : Object.entries(payload.settings ?? {})
  );
  const [busy, setBusy] = useState(false);

  return (
    <div className="p-3.5 bg-subtle border-t border-line space-y-3">
      <div className="max-w-sm">
        <FieldLabel>{t("lib.presetName")}</FieldLabel>
        <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="bg-surface border border-line rounded-[4px] p-3">
        <FieldLabel>{isStep ? t("lib.paramValues") : t("lib.presetSettings")}</FieldLabel>
        <div className="space-y-1.5">
          {isStep
            ? params.map((pp, i) => (
                <div key={i} className="grid grid-cols-[1fr_110px_70px] gap-1.5 items-center">
                  <span className="text-[12px] text-charcoal">{pp.name}</span>
                  <input
                    className="mono border border-line rounded-[3px] px-2 py-1 text-[12px]"
                    value={pp.value}
                    onChange={(e) => setParams((ps) => ps.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                  />
                  <span className="text-[11px] text-muted">{pp.unit}</span>
                </div>
              ))
            : settings.map(([k, v], i) => (
                <div key={i} className="grid grid-cols-[1fr_140px] gap-1.5 items-center">
                  <span className="text-[12px] text-charcoal">{k}</span>
                  <input
                    className="mono border border-line rounded-[3px] px-2 py-1 text-[12px]"
                    value={v}
                    onChange={(e) => setSettings((s) => s.map((x, j) => (j === i ? [k, e.target.value] : x)))}
                  />
                </div>
              ))}
          {isStep && params.length === 0 && <p className="text-[11px] text-muted">No parameters stored.</p>}
          {!isStep && settings.length === 0 && <p className="text-[11px] text-muted">No settings stored.</p>}
        </div>
      </div>
      <div className="flex gap-2 justify-end">
        <button onClick={onDone} className="border border-line rounded-[4px] px-4 py-1.5 text-[12px] font-semibold hover:bg-surface">
          {t("lib.cancel")}
        </button>
        <button
          disabled={busy || !name.trim()}
          onClick={async () => {
            setBusy(true);
            const newPayload = isStep
              ? { ...payload, parameters: params }
              : { ...payload, settings: Object.fromEntries(settings) };
            await updatePreset(preset.id, { name: name.trim(), payload: newPayload });
            setBusy(false);
            onDone();
          }}
          className="bg-ink text-white rounded-[4px] px-4 py-1.5 text-[12px] font-semibold disabled:opacity-50"
        >
          {t("lib.saveChanges")}
        </button>
      </div>
    </div>
  );
}
