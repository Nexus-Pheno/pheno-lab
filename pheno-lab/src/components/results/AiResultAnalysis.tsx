"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getAiSummaryState,
  startAiSummary,
  reviewAiSummary,
} from "@/lib/actions/experiments";
import { useLang, useT } from "@/lib/i18n/LanguageProvider";
import type {
  AiSummaryState,
  AiSummaryOptions,
} from "@/modules/experiments/summary-types";
import { Icon } from "@/components/ui";

export function AiResultAnalysis({
  experimentId,
  canAnalyze,
  referenceGroup,
  characterizationId,
}: {
  experimentId: string;
  canAnalyze: boolean;
  referenceGroup?: string;
  characterizationId?: string;
}) {
  const t = useT();
  const lang = useLang();
  const [state, setState] = useState<AiSummaryState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  const options: AiSummaryOptions = { referenceGroup, characterizationId };
  const refresh = useCallback(async () => {
    const current = await getAiSummaryState(experimentId, {
      referenceGroup,
      characterizationId,
    });
    setState(current);
    setError(false);
    setLoading(false);
    return current;
  }, [experimentId, referenceGroup, characterizationId]);
  useEffect(() => {
    let disposed = false;
    void getAiSummaryState(experimentId, { referenceGroup, characterizationId })
      .then((current) => {
        if (!disposed) {
          setState(current);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!disposed) {
          setError(true);
          setLoading(false);
        }
      });
    return () => {
      disposed = true;
    };
  }, [experimentId, referenceGroup, characterizationId]);
  const busy =
    state?.run?.state === "running" || state?.run?.state === "queued";
  useEffect(() => {
    const update = () => {
      if (document.visibilityState === "visible")
        void refresh().catch(() => {});
    };
    const timer = setInterval(update, busy ? 4000 : 45_000);
    window.addEventListener("focus", update);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", update);
    };
  }, [busy, refresh]);
  const generate = async () => {
    setError(false);
    setSaving(true);
    try {
      const run = await startAiSummary(experimentId, lang, options);
      setState((current) => (current ? { ...current, run } : current));
      await refresh();
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  };
  const review = async () => {
    if (!state?.summary?.sourceHash) return;
    setError(false);
    setSaving(true);
    try {
      await reviewAiSummary(experimentId, state.summary.sourceHash, options);
      await refresh();
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  };
  const summary = state?.summary;
  const analysis = summary?.analysis;
  return (
    <section
      id="ai-results-analysis"
      data-ai-result-analysis
      className="bg-surface border border-line rounded-[6px] p-3.5 sm:p-5 min-w-0 space-y-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Icon name="Sparkles" size={16} className="text-brand-deep" />
        <h2 className="text-[14px] font-bold flex-1">{t("res.ai.title")}</h2>
        {summary?.interim && (
          <span className="text-[11px] text-muted">{t("res.ai.interim")}</span>
        )}
        {summary && (
          <span className="text-[11px] rounded border border-line px-2 py-1">
            {t(
              summary.reviewState === "reviewed" && !state?.isStale
                ? "res.ai.reviewed"
                : "res.ai.draft",
            )}
          </span>
        )}
      </div>
      {loading ? (
        <p className="text-[12px] text-muted">{t("res.ai.loading")}</p>
      ) : (
        <>
          {(state?.isStale || (summary && !summary.sourceHash)) && (
            <p data-ai-stale className="text-[12px] text-warn">
              {t(summary?.sourceHash ? "res.ai.stale" : "res.ai.legacy")}
            </p>
          )}
          {!summary && (
            <p className="text-[12px] text-muted">
              {t(state?.hasResults ? "res.ai.empty" : "res.ai.noResults")}
            </p>
          )}
          {analysis ? (
            <>
              <div className="grid sm:grid-cols-2 gap-3 text-[12.5px]">
                <div>
                  <h3 className="font-semibold">{t("res.ai.purpose")}</h3>
                  <p className="mt-1 whitespace-pre-wrap">
                    {analysis.purpose[lang]}
                  </p>
                </div>
                <div>
                  <h3 className="font-semibold">{t("res.ai.attainment")}</h3>
                  <p className="mt-1 whitespace-pre-wrap">
                    {analysis.objectiveAttainment[lang]}
                  </p>
                </div>
              </div>
              <div className="grid lg:grid-cols-2 gap-3">
                {analysis.groups.map((group) => (
                  <article
                    key={group.group}
                    data-ai-group={group.group}
                    className="rounded border border-line p-3 space-y-2 text-[12px] min-w-0 break-words"
                  >
                    <h3 className="font-bold">
                      {group.group} · {t("res.ai.judgment")}
                    </h3>
                    <p>{group.judgment[lang]}</p>
                    <p>
                      <strong>{t("res.ai.issue")}: </strong>
                      {group.mainIssue[lang]}
                    </p>
                    <p>
                      <strong>{t("res.ai.next")}: </strong>
                      {group.nextTest[lang]}
                    </p>
                    <details>
                      <summary className="cursor-pointer font-semibold">
                        {t("res.ai.mechanisms")}
                      </summary>
                      {group.mechanisms.map((mechanism, index) => (
                        <p key={index} className="mt-2">
                          {mechanism[lang]}
                        </p>
                      ))}
                      <p className="mt-2">
                        <strong>{t("res.ai.expected")}: </strong>
                        {group.expectedOutcome[lang]}
                      </p>
                      <p className="mt-2">
                        <strong>{t("res.ai.decision")}: </strong>
                        {group.decision[lang]}
                      </p>
                    </details>
                  </article>
                ))}
              </div>
            </>
          ) : (
            summary && (
              <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap">
                {summary.text}
              </p>
            )
          )}
          {summary && (
            <p className="text-[10.5px] text-muted">
              {t("res.ai.source", {
                date: new Date(summary.generatedAt).toLocaleString(
                  lang === "zh" ? "zh-CN" : "en-GB",
                ),
                model: summary.model,
                hash: summary.sourceHash?.slice(0, 12) ?? "—",
              })}
            </p>
          )}
          {canAnalyze && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={generate}
                disabled={saving || busy || !state?.hasResults}
                className="min-h-10 px-3 rounded border border-brand/50 bg-brand-soft text-brand-deep text-[12px] font-semibold disabled:opacity-50"
              >
                {busy
                  ? t("sci.aiBusy")
                  : t(summary ? "res.ai.refresh" : "res.ai.generate")}
              </button>
              {summary?.sourceHash &&
                !state?.isStale &&
                summary.reviewState !== "reviewed" && (
                  <button
                    type="button"
                    onClick={review}
                    disabled={saving || busy}
                    className="min-h-10 px-3 rounded border border-line text-[12px] font-semibold disabled:opacity-50"
                  >
                    {saving ? t("res.ai.reviewing") : t("res.ai.review")}
                  </button>
                )}
            </div>
          )}
          {busy && (
            <p className="text-[11px] text-muted">{t("sci.aiBackground")}</p>
          )}
          {(error || state?.run?.state === "failed") && (
            <p role="status" className="text-[12px] text-danger">
              {t("res.ai.failed")}
            </p>
          )}
        </>
      )}
      <p className="text-[11px] text-muted">{t("res.ai.advisory")}</p>
    </section>
  );
}
