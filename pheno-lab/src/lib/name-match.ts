// Recognising that two written names mean the same thing.
//
// Source documents write "PbI₂", a formula sheet writes "PbI2", and the
// library stores "PbI2 (lead iodide)" — all the same material. The same
// problem shows up for equipment ("Hotplate — IKA C-MAG HS 7") and recipes.
// Comparison therefore ignores case, spacing, punctuation, unicode
// sub/superscripts, and the trailing parenthetical gloss that library names
// conventionally carry.
//
// Used by ingestion for two jobs: telling "already in the library" from
// "genuinely new", and finding duplicates before anything is published.

const SUBSCRIPT = "₀₁₂₃₄₅₆₇₈₉";
const SUPERSCRIPT = "⁰¹²³⁴⁵⁶⁷⁸⁹";

/** Comparison key: digits normalized, everything non-alphanumeric dropped. */
export function nameKey(name: string): string {
  let s = (name ?? "").toLowerCase();
  s = [...s]
    .map((ch) => {
      const sub = SUBSCRIPT.indexOf(ch);
      if (sub >= 0) return String(sub);
      const sup = SUPERSCRIPT.indexOf(ch);
      if (sup >= 0) return String(sup);
      return ch;
    })
    .join("");
  return s.replace(/[^a-z0-9]/g, "");
}

/**
 * Glosses that describe a ROLE rather than name the substance. "MACl
 * (additive)" and "RbI (additive)" are different materials, so the gloss must
 * not become a shared alias — without this, every "(additive)" in the library
 * collides with every other one.
 */
const ROLE_GLOSS = new Set([
  "additive", "precursor", "solvent", "target", "dopant", "sam", "ald",
  "evaporation", "sputter", "substrate", "antisolvent", "other", "sputtertarget",
]);

/**
 * The keys a name can be recognised by: the whole string, and — when it ends
 * in a parenthetical gloss — the part before and the gloss itself, so
 * "PbI2 (lead iodide)" answers to "PbI2" and to "lead iodide". A gloss that
 * only states the material's role is skipped (see ROLE_GLOSS).
 */
export function nameAliases(name: string): string[] {
  const raw = (name ?? "").trim();
  const keys = new Set<string>();
  const whole = nameKey(raw);
  if (whole) keys.add(whole);
  const m = raw.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
  if (m) {
    const head = nameKey(m[1]);
    const tail = nameKey(m[2]);
    if (head) keys.add(head);
    // "for ALD SnO2" and friends describe use, not identity, as does a bare
    // role word — neither identifies the substance on its own.
    if (tail && !ROLE_GLOSS.has(tail) && !/^for/.test(tail)) keys.add(tail);
  }
  return [...keys];
}

/** True when two written names refer to the same thing. */
export function sameName(a: string, b: string): boolean {
  const other = new Set(nameAliases(b));
  return nameAliases(a).some((k) => other.has(k));
}

/** An index built once and reused across many lookups. */
export function buildNameIndex<T extends { name: string }>(items: T[]): Map<string, T> {
  const index = new Map<string, T>();
  for (const item of items) {
    for (const key of nameAliases(item.name)) {
      // First entry wins, so a duplicate library row can't shadow the
      // canonical one that was loaded first.
      if (!index.has(key)) index.set(key, item);
    }
  }
  return index;
}

/** The indexed entry this written name refers to, or null if it is new. */
export function matchName<T extends { name: string }>(written: string, index: Map<string, T>): T | null {
  for (const key of nameAliases(written)) {
    const hit = index.get(key);
    if (hit) return hit;
  }
  return null;
}
