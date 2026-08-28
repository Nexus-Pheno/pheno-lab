"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getActivityFeed, type ActivityFeed } from "@/lib/actions/insights";
import { useT } from "@/lib/i18n/LanguageProvider";
import { Icon } from "@/components/ui";

// Admin-only news feed beside the kanban: who is online (presence heartbeat
// ≤5 min old) and the latest audited changes, refreshed once a minute.

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

function verbKey(action: string): string {
  if (action.includes("aiSummary")) return "act.aiSummary";
  if (action.includes("publish")) return "act.published";
  if (action.includes("import") || action.includes("merge")) return "act.imported";
  if (action.includes("duplicate")) return "act.duplicated";
  if (action.includes("delete") || action.includes("archive")) return "act.deleted";
  if (action.includes("create")) return "act.created";
  if (
    action.includes("update") ||
    action.includes("regroup") ||
    action.includes("capture") ||
    action.includes("save")
  )
    return "act.updated";
  return "act.changed";
}

function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function ActivityMonitor({ initial }: { initial: ActivityFeed }) {
  const t = useT();
  const [feed, setFeed] = useState(initial);
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    return localStorage.getItem("pheno_activity_open") !== "0";
  });

  useEffect(() => {
    const timer = setInterval(async () => {
      setNow(Date.now());
      try {
        setFeed(await getActivityFeed());
      } catch {
        // transient — keep the last feed
      }
    }, 60_000);
    return () => clearInterval(timer);
  }, []);

  const toggle = () => {
    setOpen((v) => {
      localStorage.setItem("pheno_activity_open", v ? "0" : "1");
      return !v;
    });
  };

  if (!open) {
    return (
      <button
        onClick={toggle}
        title={t("activity.title")}
        className="hidden lg:flex shrink-0 w-9 self-start mt-6 ml-3 flex-col items-center gap-1.5 py-2.5 bg-surface border border-line rounded-[6px] text-muted hover:text-charcoal"
      >
        <Icon name="Activity" size={15} />
        {feed.online.length > 0 && (
          <span className="w-4 h-4 rounded-full bg-brand-soft border border-brand/40 text-[8px] font-bold text-brand-deep flex items-center justify-center">
            {feed.online.length}
          </span>
        )}
      </button>
    );
  }

  return (
    <aside className="hidden lg:flex shrink-0 w-64 self-start mt-6 ml-3 flex-col bg-surface border border-line rounded-[6px] max-h-[calc(100dvh-8rem)]">
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-line">
        <Icon name="Activity" size={13} className="text-brand-deep" />
        <span className="text-[11px] font-bold uppercase text-muted flex-1">
          {t("activity.title")}
        </span>
        <button onClick={toggle} className="p-1 -m-1 text-muted hover:text-charcoal" title={t("activity.collapse")}>
          <Icon name="ChevronsLeft" size={13} />
        </button>
      </div>

      {/* Online now */}
      <div className="px-3 py-2 border-b border-line">
        <div className="text-[9.5px] font-bold uppercase text-muted mb-1.5">
          {t("activity.online")} ({feed.online.length})
        </div>
        <div className="flex flex-wrap gap-1">
          {feed.online.map((u) => (
            <span
              key={u.id}
              title={u.name}
              className="h-5 px-2 rounded-full bg-brand-soft border border-brand/40 text-[9.5px] font-bold text-brand-deep flex items-center gap-1"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-brand" />
              {firstName(u.name)}
            </span>
          ))}
          {feed.online.length === 0 && (
            <span className="text-[10.5px] text-muted">{t("activity.nobody")}</span>
          )}
        </div>
      </div>

      {/* Feed */}
      <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-line/60">
        {feed.events.map((e) => (
          <div key={e.id} className="px-3 py-1.5 text-[11px] leading-snug">
            <span className="font-bold text-charcoal">{firstName(e.actorName)}</span>{" "}
            <span className="text-muted">{t(verbKey(e.action) as "act.updated")}</span>{" "}
            {e.entityHref ? (
              <Link href={e.entityHref} className="text-brand-deep hover:underline break-all">
                {e.entityLabel}
              </Link>
            ) : (
              <span className="text-charcoal break-all">{e.entityLabel}</span>
            )}
            <span className="mono text-[9.5px] text-muted/80 ml-1">{ago(e.createdAt, now)}</span>
          </div>
        ))}
        {feed.events.length === 0 && (
          <p className="px-3 py-3 text-[11px] text-muted">{t("activity.empty")}</p>
        )}
      </div>
    </aside>
  );
}
