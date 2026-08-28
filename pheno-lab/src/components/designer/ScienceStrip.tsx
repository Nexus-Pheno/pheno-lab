"use client";

import { useState } from "react";
import type { ExperimentFull } from "@/lib/types";
import { generateAiSummary } from "@/lib/actions/experiments";
import { useLang, useT } from "@/lib/i18n/LanguageProvider";
import { Icon } from "@/components/ui";

type AiSummaryMeta = {
  text: string;
  lang: "en" | "zh";
  model: string;
  generatedAt: string;
};

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
  const lang = useLang();
  const [editing, setEditing] = useState<FieldKey | null>(null);
  const [draft, setDraft] = useState("");
  const [aiSummary, setAiSummary] = useState<AiSummaryMeta | null>(
    (exp.metadata as { aiSummary?: AiSummaryMeta } | null)?.aiSummary ?? null,
  );
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);

  const conclusionLocked = exp.status === "DRAFT" || exp.status === "IN_LAB";
  const editingField = FIELDS.find((f) => f.key === editing);

  const runAiSummary = async () => {
    setAiBusy(true);
    setAiError(false);
    try {
      const summary = await generateAiSummary(exp.id, lang);
      if (summary) {
        setAiSummary(summary);
        setAiOpen(true);
      } else setAiError(true);
    } catch {
      setAiError(true);
    }
    setAiBusy(false);
  };

  const open = (key: FieldKey) => {
    setDraft(exp[key]);
    setEditing(key);
  };

  const fieldRow = (f: (typeof FIELDS)[number]) => {
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
  };

  return (
    <>
      <div className="bg-surface border border-line rounded-[6px] divide-y divide-line">
        {FIELDS.filter((f) => f.key !== "conclusion").map(fieldRow)}
        {/* AI-assisted summary sits right above the conclusion: read the
            model's analysis of the full record, then write your own verdict. */}
        {!conclusionLocked && (
          <div className="px-3.5 py-2">
            <div className="flex items-center gap-2.5">
              <Icon name="Sparkles" size={13} className="shrink-0 text-brand-deep" />
              <span className="text-[10px] font-bold uppercase text-muted w-24 shrink-0">
                {t("sci.aiSummary")}
              </span>
              {aiSummary ? (
                <button
                  onClick={() => setAiOpen((v) => !v)}
                  className="text-[12.5px] text-charcoal truncate flex-1 text-left hover:underline"
                >
                  {aiSummary.text}
                </button>
              ) : (
                <span className="text-[12px] text-muted/70 truncate flex-1">
                  {t("sci.aiHint")}
                </span>
              )}
              {canEdit && (
                <button
                  disabled={aiBusy}
                  onClick={runAiSummary}
                  className="shrink-0 h-7 px-2.5 text-[11px] font-bold rounded-[4px] border border-brand/40 bg-brand-soft text-brand-deep disabled:opacity-60 flex items-center gap-1"
                >
                  {aiBusy ? (
                    <>
                      <Icon name="LoaderCircle" size={12} className="animate-spin" />
                      {t("sci.aiBusy")}
                    </>
                  ) : (
                    <>
                      <Icon name="Sparkles" size={12} />
                      {t(aiSummary ? "sci.aiRegenerate" : "sci.aiGenerate")}
                    </>
                  )}
                </button>
              )}
            </div>
            {aiError && <p className="text-[11px] text-danger mt-1.5 ml-6">{t("sci.aiFailed")}</p>}
            {aiSummary && aiOpen && (
              <div className="mt-2 ml-6 border border-brand/30 bg-brand-soft/40 rounded-[6px] p-3">
                <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-charcoal">
                  {aiSummary.text}
                </p>
                <p className="text-[10px] text-muted mt-2">
                  {t("sci.aiDisclaimer")} · {aiSummary.model} ·{" "}
                  {aiSummary.generatedAt.slice(0, 16).replace("T", " ")}
                </p>
              </div>
            )}
          </div>
        )}
        {fieldRow(FIELDS[3])}
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
