"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { reviewFeedback, submitFeedback } from "@/lib/actions/profile";
import { useT } from "@/lib/i18n/LanguageProvider";
import { Icon } from "@/components/ui";

// The feedback pipeline in one board: teammates file one problem per item
// (title + description + screenshots), the admin sifts them with comments,
// and everything approved becomes the agent's work queue.

export type FeedbackItem = {
  id: string;
  kind: string;
  title: string;
  message: string;
  screenshotPath: string;
  attachments: { id: string; storedPath: string; fileName: string }[];
  errorLog: string;
  pageUrl: string;
  status: string;
  adminNote: string;
  reviewedBy: string;
  createdAt: string;
  userName: string;
  userEmail: string;
};

const STATUS_TONE: Record<string, string> = {
  open: "bg-warn-soft text-warn border-warn-line",
  approved: "bg-brand-soft text-brand-deep border-brand/40",
  rejected: "bg-danger-soft text-danger border-danger-line",
  implemented: "bg-subtle text-muted border-line",
  resolved: "bg-subtle text-muted border-line",
};

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

function Composer({ onSubmitted }: { onSubmitted: () => void }) {
  const t = useT();
  const [kind, setKind] = useState<"bug" | "feedback">("bug");
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [shots, setShots] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const upload = async (files: FileList) => {
    setUploading(true);
    try {
      for (const file of Array.from(files).slice(0, 10 - shots.length)) {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/upload", { method: "POST", body: fd });
        const json = await res.json();
        if (json.fileName) setShots((s) => [...s, json.fileName]);
      }
    } finally {
      setUploading(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    try {
      await submitFeedback({
        kind,
        title: title.trim(),
        message: message.trim(),
        photoFileNames: shots,
        pageUrl: "",
        userAgent: navigator.userAgent.slice(0, 300),
      });
      setTitle("");
      setMessage("");
      setShots([]);
      setSent(true);
      setTimeout(() => setSent(false), 4000);
      onSubmitted();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-surface border border-line rounded-[6px] p-4 space-y-3">
      <div className="flex items-center gap-2.5">
        <span className="text-[13px] font-bold flex-1">{t("fb.newItem")}</span>
        <div className="flex border border-line rounded-[4px] overflow-hidden">
          {(["bug", "feedback"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setKind(k)}
              className={
                "px-3 h-7 text-[11.5px] font-semibold flex items-center gap-1.5 " +
                (kind === k ? "bg-ink text-white" : "bg-surface text-charcoal hover:bg-subtle")
              }
            >
              <Icon name={k === "bug" ? "Bug" : "Lightbulb"} size={12} />
              {t(k === "bug" ? "fb.bug" : "fb.feedback")}
            </button>
          ))}
        </div>
      </div>
      <input
        className="w-full h-9 border border-line rounded-[4px] px-3 text-[13px] bg-surface"
        placeholder={t("fb.titlePh")}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={300}
      />
      <textarea
        rows={3}
        className="w-full border border-line rounded-[4px] px-3 py-2.5 text-[12.5px] resize-y"
        placeholder={t("fb.messagePh")}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
      />
      <div className="flex items-center gap-2 flex-wrap">
        {shots.map((s) => (
          <span key={s} className="relative">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/api/files/${s}`} alt="screenshot" className="h-14 w-20 object-cover rounded-[4px] border border-line" />
            <button
              onClick={() => setShots((arr) => arr.filter((x) => x !== s))}
              className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-ink text-white flex items-center justify-center"
            >
              <Icon name="X" size={9} />
            </button>
          </span>
        ))}
        <input ref={fileRef} type="file" accept="image/*" multiple className="hidden"
          onChange={(e) => e.target.files && upload(e.target.files)} />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={uploading || shots.length >= 10}
          className="h-14 w-20 border border-dashed border-line rounded-[4px] flex flex-col items-center justify-center gap-0.5 text-muted hover:text-charcoal hover:bg-subtle disabled:opacity-50"
        >
          <Icon name={uploading ? "LoaderCircle" : "ImagePlus"} size={15} className={uploading ? "animate-spin" : ""} />
          <span className="text-[9px] font-semibold">{t("fb.addShot")}</span>
        </button>
        <span className="flex-1" />
        {sent && <span className="text-[11.5px] text-brand-deep font-semibold">{t("fb.submitted")}</span>}
        <button
          disabled={busy || !message.trim()}
          onClick={submit}
          className="h-9 px-5 bg-brand text-[#243000] rounded-[4px] text-[12.5px] font-bold disabled:opacity-50"
        >
          {t("fb.submit")}
        </button>
      </div>
    </div>
  );
}

function ItemCard({ f, isAdmin }: { f: FeedbackItem; isAdmin: boolean }) {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState(f.adminNote);
  const [busy, setBusy] = useState(false);

  const shots = [
    ...(f.screenshotPath ? [{ id: "legacy", storedPath: f.screenshotPath, fileName: "screenshot" }] : []),
    ...f.attachments,
  ];

  const review = async (patch: Parameters<typeof reviewFeedback>[1]) => {
    setBusy(true);
    try {
      await reviewFeedback(f.id, patch);
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-b border-line last:border-0">
      <button
        className="w-full flex items-center gap-2.5 px-3.5 py-2 hover:bg-subtle text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name={f.kind === "bug" ? "Bug" : "Lightbulb"} size={13}
          className={(f.kind === "bug" ? "text-danger" : "text-data-cyan") + " shrink-0"} />
        <span className="text-[12.5px] font-medium flex-1 truncate">
          {f.title || f.message}
        </span>
        {shots.length > 0 && (
          <span className="text-[10px] text-muted flex items-center gap-0.5 shrink-0">
            <Icon name="Image" size={11} /> {shots.length}
          </span>
        )}
        <span className="h-5 px-1.5 rounded-full bg-subtle border border-line text-[9px] font-bold text-charcoal shrink-0 max-w-16 truncate">
          {firstName(f.userName)}
        </span>
        <span className="mono text-[10px] text-muted shrink-0 hidden sm:inline">{f.createdAt}</span>
        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-[3px] border shrink-0 ${STATUS_TONE[f.status] ?? STATUS_TONE.open}`}>
          {t(`fb.st.${f.status}` as "fb.st.open")}
        </span>
      </button>

      {open && (
        <div className="px-4 py-3 bg-subtle/60 border-t border-line space-y-2.5 text-[12px]">
          {f.title && <p className="font-bold text-[13px]">{f.title}</p>}
          <p className="whitespace-pre-wrap text-charcoal">{f.message}</p>
          {shots.length > 0 && (
            <div className="flex gap-2 flex-wrap">
              {shots.map((s) => (
                <a key={s.id} href={`/api/files/${s.storedPath}`} target="_blank" rel="noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/files/${s.storedPath}`} alt={s.fileName}
                    className="h-28 rounded-[4px] border border-line hover:border-charcoal/50" />
                </a>
              ))}
            </div>
          )}
          <div className="text-[11px] text-muted">
            {f.userName} · {f.userEmail}
            {f.pageUrl && <> · <span className="mono">{f.pageUrl}</span></>}
          </div>
          {f.errorLog && (
            <pre className="mono text-[10px] bg-ink text-brand-soft rounded-[4px] p-2.5 overflow-x-auto max-h-40">{f.errorLog}</pre>
          )}

          {/* The admin's verdict — reporters see it too, so the loop closes. */}
          {isAdmin ? (
            <div className="bg-surface border border-line rounded-[4px] p-2.5 space-y-2">
              <div className="text-[10px] font-bold uppercase text-muted">{t("fb.adminNote")}</div>
              <textarea
                rows={2}
                className="w-full border border-line rounded-[4px] px-2.5 py-1.5 text-[12px] resize-y"
                placeholder={t("fb.adminNotePh")}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <div className="flex items-center gap-1.5 flex-wrap">
                {f.status !== "approved" && (
                  <button disabled={busy} onClick={() => review({ status: "approved", adminNote: note })}
                    className="h-7 px-3 bg-brand text-[#243000] rounded-[4px] text-[11.5px] font-bold disabled:opacity-50">
                    {t("fb.approve")}
                  </button>
                )}
                {f.status !== "rejected" && (
                  <button disabled={busy} onClick={() => review({ status: "rejected", adminNote: note })}
                    className="h-7 px-3 border border-danger-line text-danger rounded-[4px] text-[11.5px] font-semibold disabled:opacity-50">
                    {t("fb.reject")}
                  </button>
                )}
                {f.status === "approved" && (
                  <button disabled={busy} onClick={() => review({ status: "implemented", adminNote: note })}
                    className="h-7 px-3 border border-line text-charcoal rounded-[4px] text-[11.5px] font-semibold disabled:opacity-50">
                    {t("fb.markImplemented")}
                  </button>
                )}
                {(f.status === "rejected" || f.status === "implemented" || f.status === "resolved") && (
                  <button disabled={busy} onClick={() => review({ status: "open", adminNote: note })}
                    className="h-7 px-3 border border-line text-charcoal rounded-[4px] text-[11.5px] font-semibold disabled:opacity-50">
                    {t("fb.reopen")}
                  </button>
                )}
                <span className="flex-1" />
                {note !== f.adminNote && (
                  <button disabled={busy} onClick={() => review({ adminNote: note })}
                    className="h-7 px-3 bg-ink text-white rounded-[4px] text-[11.5px] font-semibold disabled:opacity-50">
                    {t("fb.saveNote")}
                  </button>
                )}
              </div>
            </div>
          ) : (
            (f.adminNote || f.reviewedBy) && (
              <div className="bg-brand-soft/50 border border-brand/30 rounded-[4px] p-2.5">
                <div className="text-[10px] font-bold uppercase text-brand-deep mb-1">
                  {t("fb.adminNote")}{f.reviewedBy ? ` · ${firstName(f.reviewedBy)}` : ""}
                </div>
                <p className="text-[12px] whitespace-pre-wrap text-charcoal">{f.adminNote || "—"}</p>
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}

export function FeedbackBoard({ items, isAdmin }: { items: FeedbackItem[]; isAdmin: boolean }) {
  const t = useT();
  const router = useRouter();
  const [tab, setTab] = useState<string>("open");

  const TABS = ["open", "approved", "rejected", "implemented", "all"] as const;
  const countFor = (s: string) =>
    s === "all"
      ? items.length
      : items.filter((f) => (s === "implemented" ? f.status === "implemented" || f.status === "resolved" : f.status === s)).length;
  const visible = items.filter((f) =>
    tab === "all" ? true : tab === "implemented" ? f.status === "implemented" || f.status === "resolved" : f.status === tab,
  );

  return (
    <div className="space-y-4">
      <Composer onSubmitted={() => router.refresh()} />

      <div className="flex items-center gap-1.5 flex-wrap">
        {TABS.map((s) => (
          <button
            key={s}
            onClick={() => setTab(s)}
            className={
              "h-7 px-3 rounded-full text-[11.5px] font-semibold border " +
              (tab === s ? "bg-ink text-white border-ink" : "bg-surface text-charcoal border-line hover:bg-subtle")
            }
          >
            {t(`fb.tab.${s}` as "fb.tab.open")} <span className="mono text-[10px] opacity-70">{countFor(s)}</span>
          </button>
        ))}
      </div>

      <div className="bg-surface border border-line rounded-[6px] overflow-hidden">
        {visible.map((f) => (
          <ItemCard key={f.id} f={f} isAdmin={isAdmin} />
        ))}
        {visible.length === 0 && (
          <p className="text-center text-muted text-[12.5px] py-8">{t("fb.none")}</p>
        )}
      </div>
    </div>
  );
}
