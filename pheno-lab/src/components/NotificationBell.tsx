"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useT } from "@/lib/i18n/LanguageProvider";
import { Icon } from "@/components/ui";
import {
  getUnreadCount,
  listNotifications,
  type NotificationRow,
} from "@/lib/actions/notifications";
import type { TKey } from "@/lib/i18n/dict";

const KIND_ICON: Record<string, string> = {
  access_requested: "UserPlus",
  access_approved: "CheckCircle2",
  access_declined: "XCircle",
  feedback_approved: "ThumbsUp",
  feedback_rejected: "ThumbsDown",
  feedback_implemented: "Rocket",
  feedback_commented: "MessageSquare",
  feedback_verified: "BadgeCheck",
  feedback_reopened: "RotateCcw",
  assigned: "ClipboardList",
  member_added: "Users",
  experiment_commented: "MessagesSquare",
  mentioned: "AtSign",
};

const ago = (iso: string, justNow: string): string => {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 1) return justNow;
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`;
};

/**
 * The bell next to the profile chip: an unread badge polled once a minute,
 * and a dropdown of the latest colleague interactions — access requests and
 * verdicts, feedback answers, experiment assignments. Opening the panel
 * marks everything read; each item deep-links to where the action lives.
 */
export function NotificationBell({ initialUnread }: { initialUnread: number }) {
  const t = useT();
  const [unread, setUnread] = useState(initialUnread);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationRow[] | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Badge heartbeat — same cadence as the activity monitor.
  useEffect(() => {
    const timer = setInterval(() => {
      void getUnreadCount()
        .then(setUnread)
        .catch(() => {});
    }, 60_000);
    return () => clearInterval(timer);
  }, []);

  // Tap-away closes the panel.
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) {
      void listNotifications()
        .then((rows) => {
          setItems(rows);
          setUnread(0);
        })
        .catch(() => setItems([]));
    }
  };

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={toggle}
        title={t("notif.title")}
        className="relative h-8 w-8 flex items-center justify-center border border-line rounded-[4px] hover:bg-subtle"
      >
        <Icon name="Bell" size={15} className="text-charcoal" />
        {unread > 0 && (
          <span className="absolute -top-1.5 -right-1.5 min-w-4 h-4 px-1 rounded-full bg-brand text-[#243000] text-[9.5px] font-bold flex items-center justify-center border border-surface">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-10 z-[60] w-80 max-w-[calc(100vw-24px)] bg-surface border border-line rounded-[8px] shadow-lg overflow-hidden">
          <div className="px-3 py-2 border-b border-line text-[12px] font-bold flex items-center gap-1.5">
            <Icon name="Bell" size={13} className="text-brand-deep" />
            {t("notif.title")}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {items === null && (
              <p className="p-4 text-[12px] text-muted flex items-center gap-1.5">
                <Icon name="Loader2" size={13} className="animate-spin" />
                {t("notif.loading")}
              </p>
            )}
            {items?.length === 0 && (
              <p className="p-4 text-[12px] text-muted">{t("notif.empty")}</p>
            )}
            {items?.map((n) => (
              <Link
                key={n.id}
                href={n.href || "/"}
                onClick={() => setOpen(false)}
                className={
                  "flex items-start gap-2.5 px-3 py-2.5 border-b border-line last:border-0 hover:bg-subtle " +
                  (n.unread ? "bg-brand-soft/40" : "")
                }
              >
                <Icon
                  name={KIND_ICON[n.kind] ?? "Bell"}
                  size={15}
                  className={
                    "mt-0.5 shrink-0 " +
                    (n.unread ? "text-brand-deep" : "text-muted")
                  }
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] leading-snug">
                    <b>{n.actorName}</b>{" "}
                    {t(`notif.${n.kind}` as TKey)}
                    {n.entityLabel && (
                      <span className="text-muted"> · {n.entityLabel}</span>
                    )}
                  </span>
                  <span className="block text-[10.5px] text-muted mt-0.5">
                    {ago(n.createdAt, t("notif.justNow"))}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
