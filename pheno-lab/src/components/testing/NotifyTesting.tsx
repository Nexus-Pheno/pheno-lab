"use client";

import { useRef, useState } from "react";
import { notifyTesting } from "@/lib/actions/testing";
import { useT } from "@/lib/i18n/LanguageProvider";

export function NotifyTesting({
  characterizationId,
  runId,
  samples,
}: {
  characterizationId: string;
  runId: string;
  samples: { id: string; code: string; simCode?: string | null }[];
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>(samples.map((s) => s.id));
  const [photo, setPhoto] = useState<File | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [sent, setSent] = useState(false);
  const uploaded = useRef("");
  const requestKey = useRef("");
  return (
    <div className="my-3 border border-brand/40 bg-brand-soft/30 rounded p-3">
      <button
        type="button"
        className="text-sm font-bold text-brand-deep"
        onClick={() => setOpen(!open)}
      >
        {t("testing.notify")}
      </button>
      {open && (
        <div className="mt-3 space-y-3">
          <p className="text-xs text-muted">{t("testing.notifyHint")}</p>
          <div className="flex flex-wrap gap-2">
            {samples.map((sample) => (
              <label
                key={sample.id}
                className="flex items-center gap-1 text-xs border border-line rounded px-2 py-1 bg-surface"
              >
                <input
                  type="checkbox"
                  checked={selected.includes(sample.id)}
                  disabled={sent || busy}
                  onChange={(e) =>
                    setSelected((ids) =>
                      e.target.checked
                        ? [...ids, sample.id]
                        : ids.filter((id) => id !== sample.id),
                    )
                  }
                />
                {sample.simCode || sample.code}
              </label>
            ))}
          </div>
          <label className="block text-xs">
            {t("testing.photo")}
            <input
              aria-label={t("testing.photo")}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              disabled={sent || busy}
              className="block w-full mt-1 text-xs"
              onChange={(event) => {
                setPhoto(event.target.files?.[0] ?? null);
                uploaded.current = "";
              }}
            />
          </label>
          <label className="block text-xs">
            {t("testing.instructions")}
            <textarea
              aria-label={t("testing.instructions")}
              maxLength={2000}
              value={note}
              disabled={sent || busy}
              onChange={(event) => setNote(event.target.value)}
              className="block w-full border border-line rounded bg-surface mt-1 p-2 text-sm"
            />
          </label>
          <button
            type="button"
            disabled={busy || sent || !photo || !selected.length}
            className="bg-brand text-ink font-semibold rounded px-3 py-2 text-sm disabled:opacity-50"
            onClick={async () => {
              if (!photo) return;
              setBusy(true);
              setMessage("");
              try {
                if (!uploaded.current) {
                  const body = new FormData();
                  body.set("file", photo);
                  const response = await fetch("/api/upload", {
                    method: "POST",
                    body,
                  });
                  if (!response.ok) throw new Error("upload");
                  const data = await response.json();
                  uploaded.current = data.fileName;
                }
                requestKey.current ||= crypto.randomUUID();
                const result = await notifyTesting({
                  characterizationId,
                  runId,
                  sampleIds: selected,
                  photoPath: uploaded.current,
                  note,
                  requestKey: requestKey.current,
                });
                setSent(true);
                setMessage(
                  result.groupSent
                    ? t("testing.sent")
                    : t("testing.savedNoGroup"),
                );
              } catch {
                setMessage(t("testing.sendError"));
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("testing.send")}
          </button>
          {message && (
            <p role="status" className="text-xs">
              {message}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
