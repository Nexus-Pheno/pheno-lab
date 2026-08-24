"use client";

import { useState } from "react";
import { setFeedbackStatus } from "@/lib/actions/profile";
import { useT } from "@/lib/i18n/LanguageProvider";
import { Icon } from "@/components/ui";

type Item = {
  id: string;
  kind: string;
  message: string;
  screenshotPath: string;
  errorLog: string;
  pageUrl: string;
  userAgent: string;
  status: string;
  createdAt: string;
  userName: string;
  userEmail: string;
};

export function FeedbackList({ items }: { items: Item[] }) {
  const t = useT();
  const [openId, setOpenId] = useState<string | null>(null);

  if (items.length === 0) {
    return <p className="text-center text-muted text-sm py-10">{t("fb.none")}</p>;
  }

  return (
    <div className="bg-surface border border-line rounded-[6px] overflow-hidden">
      {items.map((f) => (
        <div key={f.id} className="border-b border-line last:border-0">
          <div
            className="flex items-center gap-3 px-3.5 py-2.5 hover:bg-subtle cursor-pointer"
            onClick={() => setOpenId(openId === f.id ? null : f.id)}
          >
            <Icon name={f.kind === "bug" ? "Bug" : "MessageSquare"} size={14}
              className={f.kind === "bug" ? "text-danger shrink-0" : "text-data-cyan shrink-0"} />
            <span className="text-[12.5px] flex-1 truncate">{f.message}</span>
            <span className="text-[11px] text-muted w-28 truncate">{f.userName}</span>
            <span className="mono text-[10.5px] text-muted w-28">{f.createdAt}</span>
            <span
              className={
                "text-[10px] font-semibold px-2 py-0.5 rounded-[3px] border " +
                (f.status === "open"
                  ? "bg-warn-soft text-warn border-warn-line"
                  : "bg-subtle text-muted border-line")
              }
            >
              {t(f.status === "open" ? "fb.open" : "fb.resolved")}
            </span>
          </div>
          {openId === f.id && (
            <div className="px-4 py-3 bg-subtle border-t border-line space-y-2.5 text-[12px]">
              <p className="whitespace-pre-wrap text-charcoal">{f.message}</p>
              <div className="text-[11px] text-muted space-y-0.5">
                <div>{f.userName} · {f.userEmail}</div>
                {f.pageUrl && <div>{t("fb.page")}: <span className="mono">{f.pageUrl}</span></div>}
                {f.userAgent && <div className="mono text-[10px]">{f.userAgent}</div>}
              </div>
              {f.screenshotPath && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`/api/files/${f.screenshotPath}`} alt="screenshot"
                  className="max-h-64 rounded-[4px] border border-line" />
              )}
              {f.errorLog && (
                <div>
                  <div className="text-[10px] font-bold uppercase text-muted mb-1">{t("fb.errorLog")}</div>
                  <pre className="mono text-[10px] bg-ink text-brand-soft rounded-[4px] p-2.5 overflow-x-auto max-h-40">{f.errorLog}</pre>
                </div>
              )}
              <div>
                <button
                  onClick={() => setFeedbackStatus(f.id, f.status === "open" ? "resolved" : "open")}
                  className="text-[11px] font-semibold text-brand-deep hover:underline"
                >
                  {t(f.status === "open" ? "fb.markResolved" : "fb.reopen")}
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
