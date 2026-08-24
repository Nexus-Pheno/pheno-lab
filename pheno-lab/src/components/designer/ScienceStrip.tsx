"use client";

import { useState } from "react";
import type { ExperimentFull } from "@/lib/types";
import { useT } from "@/lib/i18n/LanguageProvider";
import { Icon } from "@/components/ui";

const FIELDS = [
  { key: "observation", labelKey: "sci.observation", icon: "Eye", phKey: "sci.observationPh" },
  { key: "problem", labelKey: "sci.problem", icon: "CircleHelp", phKey: "sci.problemPh" },
  { key: "hypothesis", labelKey: "sci.hypothesis", icon: "Lightbulb", phKey: "sci.hypothesisPh" },
  { key: "conclusion", labelKey: "sci.conclusion", icon: "Lock", phKey: "sci.observationPh" },
] as const;

type FieldKey = (typeof FIELDS)[number]["key"];

// Long, thin horizontal rows — one per narrative field. Clicking a row opens
// a large modal editor so text is never squeezed into a tiny box.
export function ScienceStrip({
  exp,
  canEdit,
  onSave,
}: {
  exp: ExperimentFull;
  canEdit: boolean;
  onSave: (patch: Partial<Record<FieldKey, string>>) => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState<FieldKey | null>(null);
  const [draft, setDraft] = useState("");

  const conclusionLocked = exp.status === "DRAFT" || exp.status === "IN_LAB";
  const editingField = FIELDS.find((f) => f.key === editing);

  const open = (key: FieldKey) => {
    setDraft(exp[key]);
    setEditing(key);
  };

  return (
    <>
      <div className="bg-surface border border-line rounded-[6px] divide-y divide-line">
        {FIELDS.map((f) => {
          const locked = f.key === "conclusion" && conclusionLocked;
          const value = exp[f.key];
          return (
            <button
              key={f.key}
              disabled={locked || !canEdit}
              onClick={() => open(f.key)}
              className={
                "w-full flex items-center gap-2.5 px-3.5 py-2 text-left " +
                (locked ? "bg-subtle cursor-default" : canEdit ? "hover:bg-subtle" : "cursor-default")
              }
            >
              <Icon name={f.icon} size={13} className="shrink-0 text-muted" />
              <span className="text-[10px] font-bold uppercase text-muted w-24 shrink-0">
                {t(f.labelKey as "sci.observation")}
              </span>
              {locked ? (
                <span className="text-[12px] italic text-muted truncate">{t("sci.conclusionLocked")}</span>
              ) : value ? (
                <span className="text-[12.5px] text-charcoal truncate flex-1">{value}</span>
              ) : (
                <span className="text-[12px] text-muted/70 truncate flex-1">
                  {t(f.phKey as "sci.observationPh")}
                </span>
              )}
              {!locked && canEdit && <Icon name="PenLine" size={12} className="shrink-0 text-muted/60" />}
            </button>
          );
        })}
      </div>

      {/* Large editor modal */}
      {editingField && (
        <div
          className="fixed inset-0 z-50 bg-ink/30 flex items-center justify-center p-4 sm:p-8"
          onClick={() => setEditing(null)}
        >
          <div
            className="w-full max-w-2xl bg-surface rounded-[8px] border border-line shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 px-4 py-3 border-b border-line">
              <Icon name={editingField.icon} size={15} className="text-charcoal" />
              <h3 className="text-[14px] font-bold flex-1">{t(editingField.labelKey as "sci.observation")}</h3>
              <button onClick={() => setEditing(null)} className="p-1 rounded-[3px] text-muted hover:bg-subtle">
                <Icon name="X" size={15} />
              </button>
            </div>
            <div className="p-4">
              <textarea
                autoFocus
                rows={8}
                className="w-full border border-line rounded-[4px] px-3.5 py-3 text-[14px] leading-relaxed resize-y min-h-40"
                placeholder={t(editingField.phKey as "sci.observationPh")}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
            </div>
            <div className="flex justify-end gap-2 px-4 pb-4">
              <button
                onClick={() => setEditing(null)}
                className="h-8 border border-line rounded-[4px] px-4 text-[12px] font-semibold text-charcoal hover:bg-subtle"
              >
                {t("insp.cancel")}
              </button>
              <button
                onClick={() => {
                  if (editing && draft !== exp[editing]) onSave({ [editing]: draft });
                  setEditing(null);
                }}
                className="h-8 bg-ink text-white rounded-[4px] px-5 text-[12px] font-bold"
              >
                {t("insp.save")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
