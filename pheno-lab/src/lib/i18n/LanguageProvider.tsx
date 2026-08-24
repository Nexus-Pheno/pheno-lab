"use client";

import { createContext, useContext, useCallback } from "react";
import { translate, type Lang, type TKey } from "./dict";
import { localizeTerm } from "./terms";

const LangContext = createContext<Lang>("en");

export function LanguageProvider({ lang, children }: { lang: Lang; children: React.ReactNode }) {
  return <LangContext.Provider value={lang}>{children}</LangContext.Provider>;
}

export function useLang(): Lang {
  return useContext(LangContext);
}

export function useT() {
  const lang = useContext(LangContext);
  return useCallback((key: TKey, vars?: Record<string, string>) => translate(lang, key, vars), [lang]);
}

/** Localize lab vocabulary (process/parameter/environment names) for display. */
export function useTerm() {
  const lang = useContext(LangContext);
  return useCallback((s: string | null | undefined) => localizeTerm(lang, s), [lang]);
}
