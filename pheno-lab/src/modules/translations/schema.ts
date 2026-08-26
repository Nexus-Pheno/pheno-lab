import { createHash } from "node:crypto";

export type TranslationLang = "en" | "zh";

/** CJK presence decides the source language; everything else counts as English. */
export function detectLang(text: string): TranslationLang {
  return /[㐀-䶿一-鿿]/.test(text) ? "zh" : "en";
}

export function counterpart(lang: TranslationLang): TranslationLang {
  return lang === "zh" ? "en" : "zh";
}

export function sourceHash(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex");
}

/** Skip empty strings and bare numbers/codes — nothing there to translate. */
export function translatable(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 2) return false;
  return /[\p{Letter}]/u.test(trimmed) && !/^[\d\s.,;:%()/+-]+$/.test(trimmed);
}
