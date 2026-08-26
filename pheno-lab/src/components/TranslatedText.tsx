"use client";

import { useEffect, useState } from "react";
import {
  lookupTranslationAction,
  requestTranslationAction,
} from "@/lib/actions/translations";
import { useLang, useT } from "@/lib/i18n/LanguageProvider";

const CJK = /[㐀-䶿一-鿿]/;

/**
 * Renders user-entered free text in the viewer's language when a cached
 * machine translation exists, with a toggle back to the original. When the
 * background pass has not translated the text yet, a small button fetches
 * the translation on demand. Text already in the viewer's language renders
 * untouched.
 */
export function TranslatedText({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const lang = useLang();
  const t = useT();
  const needsTranslation = (CJK.test(text) ? "zh" : "en") !== lang;
  const [translated, setTranslated] = useState<string | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [busy, setBusy] = useState(false);

  // Reset per text/lang without a synchronous setState inside the effect.
  const [key, setKey] = useState(`${lang}|${text}`);
  if (key !== `${lang}|${text}`) {
    setKey(`${lang}|${text}`);
    setTranslated(null);
    setShowOriginal(false);
  }

  useEffect(() => {
    if (!needsTranslation || !text.trim()) return;
    let cancelled = false;
    lookupTranslationAction(text, lang)
      .then((hit) => {
        if (!cancelled && hit) setTranslated(hit.translatedText);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [text, lang, needsTranslation]);

  if (!needsTranslation || !text.trim()) {
    return <span className={className}>{text}</span>;
  }

  const fetchNow = async () => {
    setBusy(true);
    try {
      const hit = await requestTranslationAction(text, lang);
      if (hit) setTranslated(hit.translatedText);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className={className}>
      {translated && !showOriginal ? translated : text}
      {translated ? (
        <button
          type="button"
          onClick={() => setShowOriginal((v) => !v)}
          className="ml-1.5 text-[10px] text-muted underline decoration-dotted align-baseline"
        >
          {showOriginal ? t("tr.showTranslation") : t("tr.showOriginal")}
        </button>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={fetchNow}
          className="ml-1.5 text-[10px] text-brand-deep underline decoration-dotted align-baseline disabled:opacity-50"
        >
          {busy ? t("tr.translating") : t("tr.translate")}
        </button>
      )}
    </span>
  );
}
