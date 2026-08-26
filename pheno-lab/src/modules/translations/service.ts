import "server-only";

import { db } from "@/infrastructure/db/client";
import type { Actor } from "@/modules/authorization/actor";
import { chat } from "@/modules/ai/client";
import {
  counterpart,
  detectLang,
  sourceHash,
  translatable,
  type TranslationLang,
} from "./schema";

// Machine translation of user-entered free text (observations, notes,
// conclusions). Originals are never modified; translations live in a
// content-hash cache, and a missing AI provider degrades to showing the
// original text — the LLM is never load-bearing.

function systemPrompt(target: TranslationLang): string {
  return (
    "You translate lab notes for a perovskite solar-cell research team. " +
    `Translate the user's text into ${target === "zh" ? "Simplified Chinese" : "English"}. ` +
    "Keep scientific terms precise; keep units, sample codes, formulas and numbers exactly as written. " +
    "Reply with the translation only — no explanations."
  );
}

export type TranslationHit = {
  translatedText: string;
  sourceLang: TranslationLang;
  targetLang: TranslationLang;
};

/** Cache lookup only — never calls the model. */
export async function lookupTranslation(
  actor: Actor,
  text: string,
  targetLang: TranslationLang,
): Promise<TranslationHit | null> {
  if (!translatable(text)) return null;
  const source = detectLang(text);
  if (source === targetLang) return null;
  const row = await db.translation.findUnique({
    where: {
      organizationId_sourceHash_targetLang: {
        organizationId: actor.org,
        sourceHash: sourceHash(text),
        targetLang,
      },
    },
  });
  return row
    ? { translatedText: row.translatedText, sourceLang: source, targetLang }
    : null;
}

/**
 * Cache hit or translate now. Returns null when the text needs no
 * translation or the organization has no working AI provider.
 */
export async function ensureTranslation(
  actor: Actor,
  text: string,
  targetLang: TranslationLang,
): Promise<TranslationHit | null> {
  const cached = await lookupTranslation(actor, text, targetLang);
  if (cached) return cached;
  if (!translatable(text)) return null;
  const source = detectLang(text);
  if (source === targetLang) return null;

  const reply = await chat(
    actor.org,
    [
      { role: "system", content: systemPrompt(targetLang) },
      { role: "user", content: text.trim() },
    ],
    { maxTokens: 1000 },
  );
  if (!reply?.trim()) return null;

  const row = await db.translation.upsert({
    where: {
      organizationId_sourceHash_targetLang: {
        organizationId: actor.org,
        sourceHash: sourceHash(text),
        targetLang,
      },
    },
    create: {
      organizationId: actor.org,
      sourceHash: sourceHash(text),
      sourceLang: source,
      targetLang,
      translatedText: reply.trim(),
    },
    update: { translatedText: reply.trim() },
  });
  return { translatedText: row.translatedText, sourceLang: source, targetLang };
}

/**
 * Fire-and-forget translate-on-write: after a save, warm the cache toward
 * the opposite language so readers get instant translations. Failures are
 * silent by design — the original text is always the fallback.
 */
export function queueTranslations(actor: Actor, texts: (string | undefined)[]) {
  for (const text of texts) {
    if (!text || !translatable(text)) continue;
    void ensureTranslation(actor, text, counterpart(detectLang(text))).catch(
      () => {},
    );
  }
}
