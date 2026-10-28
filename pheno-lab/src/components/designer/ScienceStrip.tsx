"use client";

import { useRef, useState } from "react";
import type { ExperimentFull } from "@/lib/types";
import {
  addExperimentImages,
  deleteExperimentImage,
} from "@/lib/actions/experiments";
import { useT } from "@/lib/i18n/LanguageProvider";
import { Icon } from "@/components/ui";
import { AiResultAnalysis } from "@/components/results/AiResultAnalysis";

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
  const [editing, setEditing] = useState<FieldKey | null>(null);
  const [draft, setDraft] = useState("");
  const conclusionLocked = exp.status === "DRAFT" || exp.status === "IN_LAB";
  const editingField = FIELDS.find((f) => f.key === editing);

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
        <AiResultAnalysis
          key={exp.id}
          experimentId={exp.id}
          canAnalyze={canEdit}
        />
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
