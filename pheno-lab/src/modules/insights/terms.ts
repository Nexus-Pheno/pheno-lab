// Pure helpers for turning a question into search terms. Kept free of
// database access so they can be unit-tested against real questions.

const STOP = new Set([
  "the",
  "a",
  "an",
  "of",
  "in",
  "on",
  "for",
  "with",
  "and",
  "or",
  "to",
  "is",
  "are",
  "what",
  "which",
  "show",
  "me",
  "all",
  "any",
  "find",
  "experiments",
  "experiment",
  "that",
  "used",
  "use",
  "using",
  "was",
  "were",
  "did",
  "do",
  "have",
  "has",
  "how",
  "best",
  "highest",
  "most",
  "only",
  "analyse",
  "analyze",
  "related",
  "从",
  "的",
  "了",
  "和",
  "与",
  "哪些",
  "实验",
  "分析",
  "相关",
  "只",
  "当时",
  "这些",
  "那个",
  "那些",
  "做的",
  "怎样",
  "如何",
  "哪个",
  "更好",
  "最好",
  "是否",
  "还是",
  "以及",
  "以前",
  "过往",
  "验证中",
]);

/** Rough tokens: whitespace / punctuation split, stop words out, max 8. */
export function terms(q: string): string[] {
  return [
    ...new Set(
      q
        .split(/[\s,;、，。?？!！"'()（）:：]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 1 && !STOP.has(s.toLowerCase())),
    ),
  ].slice(0, 8);
}

/**
 * Latin phrases inside a (mostly Chinese) question: "只分析First solar相关的实验"
 * → ["First solar"]. Names of customers, products and materials are written
 * this way, glued to the characters around them, so a whitespace split never
 * sees them. These are always searched, whatever the model picks.
 */
export function latinPhrases(q: string): string[] {
  const out: string[] = [];
  const re = /[A-Za-z][A-Za-z0-9.+-]*(?:[ ][A-Za-z][A-Za-z0-9.+-]*)*/g;
  for (const m of q.matchAll(re)) {
    const phrase = m[0].trim();
    if (phrase.length < 2 || STOP.has(phrase.toLowerCase())) continue;
    // Drop a trailing stop word ("First solar related" → "First solar").
    const words = phrase.split(" ");
    while (words.length > 1 && STOP.has(words[words.length - 1].toLowerCase()))
      words.pop();
    while (words.length > 1 && STOP.has(words[0].toLowerCase())) words.shift();
    const cleaned = words.join(" ");
    if (STOP.has(cleaned.toLowerCase())) continue;
    if (cleaned.length >= 2 && !out.includes(cleaned)) out.push(cleaned);
  }
  return out;
}

/** Merge model-picked terms with the phrases that must never be lost. */
export function mergeTerms(
  picked: string[],
  must: string[],
  max = 8,
): string[] {
  const out: string[] = [];
  for (const t of [...must, ...picked]) {
    const v = t.trim();
    if (v.length < 2) continue;
    if (out.some((o) => o.toLowerCase() === v.toLowerCase())) continue;
    out.push(v);
  }
  return out.slice(0, max);
}
