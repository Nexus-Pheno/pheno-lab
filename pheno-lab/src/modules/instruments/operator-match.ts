/**
 * Resolves the operator name typed on an instrument to a registered account.
 *
 * Operators type their own name into the rig, so "Davidd", "david " and "DAVID"
 * all mean the same person. But a wrong match hands one person's measurements
 * to another, so this never guesses between two people: a near-miss is accepted
 * ONLY when exactly one account is within one character. Anything ambiguous
 * resolves to null and the scan falls through to the manager/admin queue.
 */

export type MatchableUser = { id: string; name: string; active: boolean };

/** "Jiantao  Wang" → "jiantaowang"; punctuation and spacing carry no meaning. */
export function normalizeOperatorName(raw: string): string {
  return raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Levenshtein distance, capped: we only ever care about "is it ≤ 1". */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (long.length - short.length > 1) return false;

  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    // A substitution advances both; an insertion advances only the longer side.
    if (short.length === long.length) i++;
    j++;
  }
  // Whatever is left of the longer string is one more edit.
  return edits + (long.length - j) + (short.length - i) <= 1;
}

/**
 * The account this operator name belongs to, or null when it is blank, unknown,
 * or ambiguous. Only active accounts are considered — a deactivated import
 * placeholder must never become the owner of live data.
 */
export function matchOperatorToUser(
  operator: string,
  users: MatchableUser[],
): MatchableUser | null {
  const typed = normalizeOperatorName(operator ?? "");
  if (!typed) return null;

  const candidates = users.filter((u) => u.active && u.name.trim());

  const exact = candidates.filter(
    (u) => normalizeOperatorName(u.name) === typed,
  );
  // Two accounts with the same normalized name is a lab problem, not something
  // to resolve by picking one.
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;

  // A single-character typo is common enough to be worth catching, but only
  // when it cannot mean two different people.
  const near = candidates.filter((u) =>
    withinOneEdit(normalizeOperatorName(u.name), typed),
  );
  return near.length === 1 ? near[0] : null;
}
