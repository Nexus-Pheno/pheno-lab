"use client";

import { useState, useTransition } from "react";
import { useT } from "@/lib/i18n/LanguageProvider";
import { Icon } from "@/components/ui";
import { analyzeHistory, type HistoryAnalysis } from "@/lib/actions/insights";

/**
 * Ask a question across the whole experiment history — "spin vs blade SAM,
 * which is better?" — and get a cited, number-exact analysis. The call is
 * synchronous (~30–60s): the answer belongs to the question just typed, so
 * unlike the per-experiment summary there is nothing to come back to later.
 */
export function AiAnalysis({ lang }: { lang: "en" | "zh" }) {
  const t = useT();
  const [q, setQ] = useState("");
  const [result, setResult] = useState<HistoryAnalysis | null>(null);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();

  const run = () => {
    if (!q.trim() || pending) return;
    setError(false);
    start(async () => {
      try {
        const r = await analyzeHistory(q, lang);
        if (r) setResult(r);
        else setError(true);
      } catch {
        setError(true);
      }
    });
  };

  return (
    <div className="border border-brand/40 bg-brand-soft/30 rounded-[6px] overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full px-3 py-1.5 flex items-center gap-1.5 text-left"
      >
        <Icon name="Sparkles" size={13} className="text-brand-deep shrink-0" />
        <span className="text-[12px] font-bold text-brand-deep flex-1">
          {t("di.title")}
        </span>
        <Icon
          name={open ? "ChevronUp" : "ChevronDown"}
          size={13}
          className="text-muted shrink-0"
        />
      </button>
      {open && (
        <div className="px-3 pb-2.5">
          <p className="text-[10.5px] text-muted mb-1.5">{t("di.hint")}</p>
          <div className="flex gap-1.5">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && run()}
              placeholder={t("di.ph")}
              disabled={pending}
              className="h-9 flex-1 min-w-0 border border-line rounded-[4px] px-2.5 text-[13px] bg-surface"
            />
            <button
              onClick={run}
              disabled={pending || !q.trim()}
              className="h-9 shrink-0 px-3.5 text-[12.5px] font-bold text-[#243000] bg-brand rounded-[4px] disabled:opacity-50 flex items-center gap-1.5"
            >
              {pending && (
                <Icon name="Loader2" size={13} className="animate-spin" />
              )}
              {pending ? t("di.running") : t("di.run")}
            </button>
          </div>
          {error && (
            <p className="text-[11px] text-warn mt-1.5">{t("di.error")}</p>
          )}
          {result && !pending && (
            <div className="mt-2 border border-brand/30 bg-surface rounded-[4px] p-2.5 max-h-80 overflow-y-auto">
              <div className="text-[12.5px] text-brand-deep leading-relaxed whitespace-pre-wrap">
                {result.text}
              </div>
              <p className="text-[10px] text-muted mt-2">
                {t("di.footer", {
                  n: String(result.experiments),
                  model: result.model,
                })}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
