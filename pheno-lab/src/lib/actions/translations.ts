"use server";

import { requireSession } from "@/lib/auth";
import {
  ensureTranslation,
  lookupTranslation,
} from "@/modules/translations/service";
import type { TranslationLang } from "@/modules/translations/schema";

/** Cache-only lookup for render time — never blocks on the model. */
export async function lookupTranslationAction(
  text: string,
  targetLang: TranslationLang,
) {
  const session = await requireSession();
  return lookupTranslation(session, String(text), targetLang);
}

/** Translate-on-demand for text the background pass has not reached. */
export async function requestTranslationAction(
  text: string,
  targetLang: TranslationLang,
) {
  const session = await requireSession();
  return ensureTranslation(session, String(text), targetLang);
}
