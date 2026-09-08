"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/lib/i18n/LanguageProvider";
import { Icon } from "@/components/ui";
import { fuzzyFilter } from "@/lib/fuzzy";
import {
  addExperimentComment,
  deleteExperimentComment,
  listExperimentComments,
} from "@/lib/actions/comments";
import type { CommentRow } from "@/modules/experiments/comment-service";

// Same minute-resolution stamp the notification bell uses.
const ago = (iso: string, justNow: string): string => {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 1) return justNow;
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`;
};

type Person = { id: string; name: string; email: string };

/**
 * The experiment's discussion thread — lives at the bottom of the designer
 * canvas. Typing @ opens a people picker; picking someone inserts their name
 * and queues a bell notification for them. Mentions never grant access.
 */
export function CommentsPanel({
  experimentId,
  users,
  sessionUid,
}: {
  experimentId: string;
  users: Person[];
  sessionUid: string;
}) {
  const t = useT();
  const [comments, setComments] = useState<CommentRow[] | null>(null);
  const [text, setText] = useState("");
  const [mentions, setMentions] = useState<Person[]>([]);
  const [shots, setShots] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      listExperimentComments(experimentId)
        .then((rows) => {
          if (!cancelled) setComments(rows);
        })
        .catch(() => {});
    void load();
    const timer = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [experimentId]);

  // The @ popup tracks a trailing "@query" fragment (no newline, short).
  const mentionQuery = useMemo(() => {
    const at = text.lastIndexOf("@");
    if (at < 0) return null;
    if (at > 0 && !/\s/.test(text[at - 1])) return null;
    const fragment = text.slice(at + 1);
    if (fragment.length > 24 || fragment.includes("\n")) return null;
    return fragment;
  }, [text]);

  const matches = useMemo(() => {
    if (mentionQuery === null) return [];
    const pool = users.filter(
      (u) => u.id !== sessionUid && !mentions.some((m) => m.id === u.id),
    );
    return fuzzyFilter(pool, mentionQuery, (u) => `${u.name} ${u.email}`).slice(
      0,
      6,
    );
  }, [mentionQuery, users, mentions, sessionUid]);

  const pick = (person: Person) => {
    const at = text.lastIndexOf("@");
    setText(`${text.slice(0, at)}@${person.name} `);
    setMentions((m) => [...m, person]);
    inputRef.current?.focus();
  };

  const post = async () => {
    const body = text.trim();
    if (!body && shots.length === 0) return;
    if (!body) return;
    setBusy(true);
    try {
      const row = await addExperimentComment({
        experimentId,
        body,
        // Only keep mentions whose name still appears — deleting the text
        // deletes the notification.
        mentionIds: mentions
          .filter((m) => body.includes(`@${m.name}`))
          .map((m) => m.id),
        photoFileNames: shots,
      });
      setComments((rows) => [...(rows ?? []), row]);
      setText("");
      setMentions([]);
      setShots([]);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setComments((rows) => (rows ?? []).filter((r) => r.id !== id));
    try {
      await deleteExperimentComment(id);
    } catch {
      // Refetch on failure so the row comes back.
      void listExperimentComments(experimentId).then(setComments);
    }
  };

  return (
    <section className="bg-surface border border-line rounded-[6px] p-4 mt-4">
      <h2 className="text-[13px] font-bold flex items-center gap-1.5 mb-2.5">
        <Icon name="MessagesSquare" size={14} className="text-charcoal" />
        {t("cmt.title")}
        {comments && comments.length > 0 && (
          <span className="mono text-[11px] text-muted font-normal">
            {comments.length}
          </span>
        )}
      </h2>

      <div className="space-y-2.5 mb-3">
        {comments === null ? (
          <p className="text-[12px] text-muted">…</p>
        ) : comments.length === 0 ? (
          <p className="text-[12px] text-muted">{t("cmt.empty")}</p>
        ) : (
          comments.map((c) => (
            <div key={c.id} className="flex gap-2.5">
              <span className="shrink-0 w-7 h-7 rounded-full bg-brand-soft border border-brand/40 flex items-center justify-center text-[10px] font-bold text-brand-deep">
                {c.author.trim().slice(0, 2).toUpperCase()}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="text-[12px] font-semibold">{c.author}</span>
                  <span className="text-[10.5px] text-muted">
                    {ago(c.createdAt, t("notif.justNow"))}
                  </span>
                  {c.authorId === sessionUid && (
                    <button
                      onClick={() => remove(c.id)}
                      title={t("cmt.delete")}
                      className="ml-auto text-muted/50 hover:text-danger"
                    >
                      <Icon name="X" size={11} />
                    </button>
                  )}
                </div>
                <p className="text-[12.5px] leading-snug whitespace-pre-wrap break-words">
                  {c.body}
                </p>
                {c.photos.length > 0 && (
                  <div className="flex gap-1.5 flex-wrap mt-1">
                    {c.photos.map((ph) => (
                      <a
                        key={ph.id}
                        href={`/api/files/${ph.path}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={`/api/files/${ph.path}`}
                          alt=""
                          className="h-16 rounded-[4px] border border-line hover:border-charcoal/50"
                        />
                      </a>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="relative">
        {matches.length > 0 && (
          <div className="absolute bottom-full mb-1 left-0 w-64 bg-surface border border-line rounded-[6px] shadow-md overflow-hidden z-10">
            {matches.map((u) => (
              <button
                key={u.id}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(u);
                }}
                className="w-full text-left px-2.5 py-1.5 hover:bg-subtle"
              >
                <span className="text-[12px] font-semibold">{u.name}</span>
                <span className="mono text-[10px] text-muted ml-2">
                  {u.email}
                </span>
              </button>
            ))}
          </div>
        )}
        {shots.length > 0 && (
          <div className="flex gap-1.5 flex-wrap mb-1.5">
            {shots.map((key) => (
              <span key={key} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/files/${key}`}
                  alt=""
                  className="h-12 w-16 object-cover rounded-[4px] border border-brand/50"
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
          </div>
        )}
        <div className="flex items-end gap-2">
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
            title={t("fb.addShot")}
            className="h-9 w-9 shrink-0 border border-line rounded-[4px] flex items-center justify-center text-muted hover:text-charcoal hover:bg-subtle disabled:opacity-50"
          >
            <Icon
              name={uploading ? "LoaderCircle" : "ImagePlus"}
              size={14}
              className={uploading ? "animate-spin" : ""}
            />
          </button>
          <textarea
            ref={inputRef}
            rows={2}
            value={text}
            placeholder={t("cmt.placeholder")}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void post();
            }}
            className="flex-1 border border-line rounded-[4px] px-3 py-2 text-[12.5px] resize-y min-h-[52px]"
          />
          <button
            disabled={busy || !text.trim()}
            onClick={post}
            className="h-9 bg-ink text-white rounded-[4px] px-3.5 text-[12px] font-semibold disabled:opacity-50 flex items-center gap-1.5"
          >
            <Icon name="Send" size={12} />
            {t("cmt.post")}
          </button>
        </div>
      </div>
    </section>
  );
}
