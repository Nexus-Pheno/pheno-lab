"use client";

import { useEffect, useState, useTransition } from "react";
import { useT } from "@/lib/i18n/LanguageProvider";
import { Icon } from "@/components/ui";
import { askAnalysis, pollAnalysis } from "@/lib/actions/analysis";
import type { AnalysisRunRow } from "@/modules/analysis/ask-service";

// Ask mode: the question picks the experiments. The run is detached and
// polled, so leaving the page and coming back finds the answer in the history.
export function AskPanel({
  history,
  lang,
}: {
  history: AnalysisRunRow[];
  lang: "en" | "zh";
}) {
  const t = useT();
  const [question, setQuestion] = useState("");
  const [runs, setRuns] = useState<AnalysisRunRow[]>(history);
  const [open, setOpen] = useState<string | null>(
    history.find((r) => r.status === "DONE")?.id ?? null,
  );
  const [pending, startTransition] = useTransition();

  const running = runs.filter((r) => r.status === "RUNNING").map((r) => r.id);

  useEffect(() => {
    if (running.length === 0) return;
    const timer = setInterval(async () => {
      for (const id of running) {
        try {
          const fresh = await pollAnalysis(id);
          if (fresh && fresh.status !== "RUNNING") {
            setRuns((list) => list.map((r) => (r.id === id ? fresh : r)));
            if (fresh.status === "DONE") setOpen(id);
          }
        } catch {
          // transient poll failure: try again on the next tick
        }
      }
    }, 4000);
    return () => clearInterval(timer);
  }, [running.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  const ask = () => {
    const asked = question.trim();
    if (asked.length < 3) return;
    startTransition(async () => {
      const run = await askAnalysis(asked, lang);
      setRuns((list) => [run, ...list]);
      setOpen(run.id);
      setQuestion("");
    });
  };

  return (
    <div className="space-y-3">
      <section className="bg-surface border border-line rounded-[6px] p-3.5">
        <h2 className="text-[12.5px] font-bold flex items-center gap-1.5">
          <Icon name="Sparkles" size={14} className="text-brand-deep" />
          {t("an.askTitle")}
        </h2>
        <p className="text-[10.5px] text-muted mb-2 max-w-3xl">
          {t("an.askHint")}
        </p>
        <textarea
          className="w-full border border-line rounded-[4px] px-3 py-2 text-[13px] bg-surface min-h-[76px]"
          placeholder={t("an.askPlaceholder")}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) ask();
          }}
          disabled={pending}
        />
        <div className="flex items-center justify-between mt-2">
          <span className="text-[10.5px] text-muted">
            {t("an.askShortcut")}
          </span>
          <button
            onClick={ask}
            disabled={pending || question.trim().length < 3}
            className="h-[30px] px-3 rounded-[4px] bg-brand text-[#243000] text-[11.5px] font-bold disabled:opacity-50 flex items-center gap-1.5"
          >
            {pending && <Icon name="Loader" size={12} />}
            {t("an.askButton")}
          </button>
        </div>
      </section>

      {runs.length === 0 && (
        <p className="text-[12px] text-muted px-1">{t("an.noHistory")}</p>
      )}

      {runs.map((run) => {
        const isOpen = open === run.id;
        return (
          <section
            key={run.id}
            className="bg-surface border border-line rounded-[6px] overflow-hidden"
          >
            <button
              onClick={() => setOpen(isOpen ? null : run.id)}
              className="w-full text-left px-3.5 py-2.5 flex items-start gap-2 hover:bg-subtle"
            >
              <span className="mt-0.5 shrink-0">
                {run.status === "RUNNING" && (
                  <Icon name="Loader" size={13} className="text-brand-deep" />
                )}
                {run.status === "DONE" && (
                  <Icon
                    name="CircleCheck"
                    size={13}
                    className="text-brand-deep"
                  />
                )}
                {run.status === "FAILED" && (
                  <Icon name="CircleAlert" size={13} className="text-danger" />
                )}
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-[13px] font-semibold text-ink">
                  {run.question}
                </span>
                <span className="block text-[10.5px] text-muted mono mt-0.5">
                  {run.requestedBy} · {run.startedAt}
                  {run.status === "DONE" &&
                    ` · ${t("an.basedOn")
                      .replace("{experiments}", String(run.experiments))
                      .replace("{samples}", String(run.samples))}`}
                  {run.status === "RUNNING" && ` · ${t("an.running")}`}
                  {run.status === "FAILED" && ` · ${t("an.runFailed")}`}
                </span>
              </span>
              <Icon
                name={isOpen ? "ChevronUp" : "ChevronDown"}
                size={14}
                className="text-muted shrink-0 mt-0.5"
              />
            </button>
            {isOpen && run.status === "DONE" && (
              <div className="px-3.5 pb-3.5 border-t border-line">
                <div className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink pt-3">
                  {run.text}
                </div>
                {run.terms.length > 0 && (
                  <p className="mt-3 text-[10px] text-muted mono leading-relaxed">
                    {t("an.terms")}: {run.terms.join(" · ")}
                  </p>
                )}
                {run.experimentCodes.length > 0 && (
                  <p className="mt-3 text-[10px] text-muted mono leading-relaxed">
                    {t("an.experimentsRead")}: {run.experimentCodes.join(" · ")}
                  </p>
                )}
                <p className="mt-1 text-[10px] text-muted mono">
                  {t("an.generated")
                    .replace("{when}", run.finishedAt ?? run.startedAt)
                    .replace("{model}", run.model)}
                </p>
              </div>
            )}
            {isOpen && run.status === "FAILED" && (
              <p className="px-3.5 pb-3 text-[11.5px] text-danger">
                {t("an.aiFailed")}
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}
