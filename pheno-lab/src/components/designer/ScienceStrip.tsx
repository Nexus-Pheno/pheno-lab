"use client";

import { useEffect, useRef, useState } from "react";
import type { ExperimentFull } from "@/lib/types";
import {
  addExperimentImages,
  deleteExperimentImage,
  getAiSummaryState,
  startAiSummary,
} from "@/lib/actions/experiments";
import { useLang, useT } from "@/lib/i18n/LanguageProvider";
import { Icon } from "@/components/ui";

type AiSummaryMeta = {
  text: string;
  lang: "en" | "zh";
  model: string;
  generatedAt: string;
};

type AiRunMeta = {
  state: "running" | "done" | "failed";
  startedAt: string;
  lang: "en" | "zh";
};

// Mirrors AI_SUMMARY_STALE_MS server-side: a "running" marker older than
// this belongs to a crashed run and must not spin forever.
const RUN_STALE_MS = 3 * 60_000;

const isRunning = (run: AiRunMeta | null) =>
  run?.state === "running" &&
  Date.now() - Date.parse(run.startedAt) < RUN_STALE_MS;

const FIELDS = [
  {
    key: "observation",
    labelKey: "sci.observation",
    icon: "Eye",
    phKey: "sci.observationPh",
  },
  {
    key: "problem",
    labelKey: "sci.problem",
    icon: "CircleHelp",
    phKey: "sci.problemPh",
  },
  {
    key: "hypothesis",
    labelKey: "sci.hypothesis",
    icon: "Lightbulb",
    phKey: "sci.hypothesisPh",
  },
  {
    key: "conclusion",
    labelKey: "sci.conclusion",
    icon: "Lock",
    phKey: "sci.observationPh",
  },
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
  const meta = exp.metadata as {
    aiSummary?: AiSummaryMeta;
    aiSummaryRun?: AiRunMeta;
  } | null;
  const [aiSummary, setAiSummary] = useState<AiSummaryMeta | null>(
    meta?.aiSummary ?? null,
  );
  // The run marker is persisted server-side, so a generation started before
  // navigating away is picked up again on mount and keeps spinning here.
  const [aiRun, setAiRun] = useState<AiRunMeta | null>(
    meta?.aiSummaryRun ?? null,
  );
  const [aiError, setAiError] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const aiBusy = isRunning(aiRun);

  const conclusionLocked = exp.status === "DRAFT" || exp.status === "IN_LAB";
  const editingField = FIELDS.find((f) => f.key === editing);

  const runAiSummary = async () => {
    setAiError(false);
    try {
      setAiRun(await startAiSummary(exp.id, lang));
    } catch {
      setAiError(true);
    }
  };

  // While a generation is running, poll until the server marker resolves.
  useEffect(() => {
    if (!aiBusy) return;
    const timer = setInterval(async () => {
      try {
        const state = await getAiSummaryState(exp.id);
        if (!state) return;
        if (state.summary) setAiSummary(state.summary);
        if (state.run) {
          setAiRun(state.run);
          if (state.run.state === "done") setAiOpen(true);
          if (state.run.state === "failed") setAiError(true);
        }
      } catch {
        // transient poll failure — keep trying until the stale cutoff
      }
    }, 4000);
    return () => clearInterval(timer);
  }, [aiBusy, exp.id]);

  // Field images (Tyler's feedback: an IV curve says more than a paragraph).
  const [images, setImages] = useState(exp.attachments);
  const [shots, setShots] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const imagesFor = (key: FieldKey) =>
    images.filter((img) => img.context === key);

  const upload = async (files: FileList) => {
    setUploading(true);
    try {
      for (const file of Array.from(files).slice(0, 10 - shots.length)) {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/upload", { method: "POST", body: fd });
        const json = await res.json();
        if (json.fileName) setShots((arr) => [...arr, json.fileName]);
      }
    } finally {
      setUploading(false);
    }
  };

  const removeImage = async (id: string) => {
    setImages((arr) => arr.filter((img) => img.id !== id));
    await deleteExperimentImage(id, exp.id);
  };

  const open = (key: FieldKey) => {
    setDraft(exp[key]);
    setShots([]);
    setEditing(key);
  };

  const fieldRow = (f: (typeof FIELDS)[number]) => {
    const locked = f.key === "conclusion" && conclusionLocked;
    const value = exp[f.key];
    const row = (
      <button
        key={f.key}
        disabled={locked || !canEdit}
        onClick={() => open(f.key)}
        className={
          "w-full flex items-center gap-2.5 px-3.5 py-2 text-left " +
          (locked
            ? "bg-subtle cursor-default"
            : canEdit
              ? "hover:bg-subtle"
              : "cursor-default")
        }
      >
        <Icon name={f.icon} size={13} className="shrink-0 text-muted" />
        <span className="text-[10px] font-bold uppercase text-muted w-24 shrink-0">
          {t(f.labelKey as "sci.observation")}
        </span>
        {locked ? (
          <span className="text-[12px] italic text-muted truncate">
            {t("sci.conclusionLocked")}
          </span>
        ) : value ? (
          <span className="text-[12.5px] text-charcoal truncate flex-1">
            {value}
          </span>
        ) : (
          <span className="text-[12px] text-muted/70 truncate flex-1">
            {t(f.phKey as "sci.observationPh")}
          </span>
        )}
        {!locked && canEdit && (
          <Icon name="PenLine" size={12} className="shrink-0 text-muted/60" />
        )}
        {imagesFor(f.key).length > 0 && (
          <span className="shrink-0 text-[10px] text-muted flex items-center gap-0.5">
            <Icon name="Image" size={11} /> {imagesFor(f.key).length}
          </span>
        )}
      </button>
    );
    if (imagesFor(f.key).length === 0) return row;

    return (
      <div key={f.key}>
        {row}
        <div className="no-scrollbar flex gap-1.5 overflow-x-auto px-3.5 pb-2">
          {imagesFor(f.key).map((img) => (
            <a
              key={img.id}
              href={`/api/files/${img.storedPath}`}
              target="_blank"
              rel="noreferrer"
              className="shrink-0"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/files/${img.storedPath}`}
                alt=""
                className="h-12 rounded-[4px] border border-line hover:border-charcoal/50"
              />
            </a>
          ))}
        </div>
      </div>
    );
  };

  return (
    <>
      <div className="bg-surface border border-line rounded-[6px] divide-y divide-line">
        {FIELDS.filter((f) => f.key !== "conclusion").map(fieldRow)}
        {/* AI-assisted summary sits right above the conclusion: read the
            model's analysis of the full record, then write your own verdict.
            On drafts it is visible but locked, like the conclusion, so the
            team knows the feature exists. */}
        {conclusionLocked ? (
          <div className="w-full flex items-center gap-2.5 px-3.5 py-2 bg-subtle cursor-default">
            <Icon name="Sparkles" size={13} className="shrink-0 text-muted" />
            <span className="text-[10px] font-bold uppercase text-muted w-24 shrink-0">
              {t("sci.aiSummary")}
            </span>
            <span className="text-[12px] italic text-muted truncate">
              {t("sci.aiLocked")}
            </span>
          </div>
        ) : (
          <div className="px-3.5 py-2">
            <div className="flex items-center gap-2.5">
              <Icon
                name="Sparkles"
                size={13}
                className="shrink-0 text-brand-deep"
              />
              <span className="text-[10px] font-bold uppercase text-muted w-24 shrink-0">
                {t("sci.aiSummary")}
              </span>
              {aiSummary ? (
                // A span, not a button: globals.css resets every button to
                // `font: inherit` OUTSIDE the cascade layers, which beats all
                // font utilities and rendered this line at 16px. As a span it
                // matches the sibling rows exactly; green marks it AI-made.
                <span
                  role="button"
                  tabIndex={0}
                  onClick={() => setAiOpen((v) => !v)}
                  onKeyDown={(e) => e.key === "Enter" && setAiOpen((v) => !v)}
                  className="text-[12.5px] text-brand-deep truncate flex-1 cursor-pointer hover:underline"
                >
                  {aiSummary.text}
                </span>
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
                      <Icon
                        name="LoaderCircle"
                        size={12}
                        className="animate-spin"
                      />
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
            {aiBusy && (
              <p className="text-[11px] text-muted mt-1.5 ml-6">
                {t("sci.aiBackground")}
              </p>
            )}
            {aiError && !aiBusy && (
              <p className="text-[11px] text-danger mt-1.5 ml-6">
                {t("sci.aiFailed")}
              </p>
            )}
            {aiSummary && aiOpen && (
              <div className="mt-2 ml-6 border border-brand/30 bg-brand-soft/40 rounded-[6px] p-3">
                <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-brand-deep">
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
              <Icon
                name={editingField.icon}
                size={15}
                className="text-charcoal"
              />
              <h3 className="text-[14px] font-bold flex-1">
                {t(editingField.labelKey as "sci.observation")}
              </h3>
              <button
                onClick={() => setEditing(null)}
                className="p-1 rounded-[3px] text-muted hover:bg-subtle"
              >
                <Icon name="X" size={15} />
              </button>
            </div>
            <div className="p-4 space-y-3">
              <textarea
                autoFocus
                rows={8}
                className="w-full border border-line rounded-[4px] px-3.5 py-3 text-[14px] leading-relaxed resize-y min-h-40"
                placeholder={t(editingField.phKey as "sci.observationPh")}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
              <div className="flex items-center gap-2 flex-wrap">
                {editing &&
                  imagesFor(editing).map((img) => (
                    <span key={img.id} className="relative">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`/api/files/${img.storedPath}`}
                        alt=""
                        className="h-14 w-20 object-cover rounded-[4px] border border-line"
                      />
                      <button
                        onClick={() => removeImage(img.id)}
                        className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-ink text-white flex items-center justify-center"
                      >
                        <Icon name="X" size={9} />
                      </button>
                    </span>
                  ))}
                {shots.map((key) => (
                  <span key={key} className="relative">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`/api/files/${key}`}
                      alt=""
                      className="h-14 w-20 object-cover rounded-[4px] border border-brand/50"
                    />
                    <button
                      onClick={() =>
                        setShots((arr) => arr.filter((k) => k !== key))
                      }
                      className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-ink text-white flex items-center justify-center"
                    >
                      <Icon name="X" size={9} />
                    </button>
                  </span>
                ))}
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(e) => e.target.files && upload(e.target.files)}
                />
                <button
                  onClick={() => fileRef.current?.click()}
                  disabled={uploading || shots.length >= 10}
                  className="h-14 w-20 border border-dashed border-line rounded-[4px] flex flex-col items-center justify-center gap-0.5 text-muted hover:text-charcoal hover:bg-subtle disabled:opacity-50"
                >
                  <Icon
                    name={uploading ? "LoaderCircle" : "ImagePlus"}
                    size={15}
                    className={uploading ? "animate-spin" : ""}
                  />
                  <span className="text-[9px] font-semibold">
                    {t("fb.addShot")}
                  </span>
                </button>
              </div>
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
                  const field = editing;
                  if (field && draft !== exp[field]) onSave({ [field]: draft });
                  if (field && shots.length > 0) {
                    void addExperimentImages(exp.id, field, shots).then(
                      (rows) =>
                        setImages((prev) => [
                          ...prev.filter((img) => img.context !== field),
                          ...rows.map((r) => ({
                            id: r.id,
                            storedPath: r.path,
                            context: r.context,
                          })),
                        ]),
                    );
                  }
                  setShots([]);
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
