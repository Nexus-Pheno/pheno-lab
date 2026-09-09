"use client";

import { useState, useTransition } from "react";
import { useT } from "@/lib/i18n/LanguageProvider";
import { Icon, inputCls } from "@/components/ui";
import { analyseScope } from "@/lib/actions/analysis";

type Reading = {
  text: string;
  model: string;
  experiments: number;
  samples: number;
  generatedAt: string;
};

// The narrative layer over the computed tables. The call is synchronous
// (~30-60s): the answer belongs to the question just asked, and the tables it
// reads are already on the page if the model is unavailable.
export function AiReading({
  scope,
  lang,
}: {
  scope: Record<string, string | undefined>;
  lang: "en" | "zh";
}) {
  const t = useT();
  const [question, setQuestion] = useState("");
  const [reading, setReading] = useState<Reading | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, startTransition] = useTransition();

  const ask = () => {
    const asked = question.trim();
    if (!asked) return;
    setFailed(false);
    startTransition(async () => {
      try {
        const result = await analyseScope(asked, scope, lang);
        if (result) setReading(result);
        else setFailed(true);
      } catch {
        setFailed(true);
      }
    });
  };

  return (
    <section className="bg-surface border border-line rounded-[6px] p-3.5">
      <h2 className="text-[12.5px] font-bold flex items-center gap-1.5">
        <Icon name="Sparkles" size={14} className="text-brand-deep" />
        {t("an.ai")}
      </h2>
      <p className="text-[10.5px] text-muted mb-2">{t("an.aiHint")}</p>

      <div className="flex items-center gap-1.5">
        <input
          className={inputCls}
          placeholder={t("an.ask")}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && ask()}
          disabled={pending}
        />
        <button
          onClick={ask}
          disabled={pending || !question.trim()}
          className="shrink-0 h-[30px] px-3 rounded-[4px] bg-brand text-[#243000] text-[11.5px] font-bold disabled:opacity-50 flex items-center gap-1.5"
        >
          {pending && <Icon name="Loader" size={12} />}
          {pending ? t("an.asking") : t("an.ask")}
        </button>
      </div>

      {failed && (
        <p className="mt-2 text-[11.5px] text-danger">{t("an.aiFailed")}</p>
      )}

      {reading && (
        <div className="mt-3">
          <div className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink">
            {reading.text}
          </div>
          <p className="mt-2 text-[10px] text-muted mono">
            {t("an.generated")
              .replace("{when}", reading.generatedAt)
              .replace("{model}", reading.model)}{" "}
            · {reading.experiments}/{reading.samples}
          </p>
        </div>
      )}
    </section>
  );
}
