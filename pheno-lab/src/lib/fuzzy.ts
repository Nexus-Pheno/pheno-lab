// Small fuzzy matcher for material search: tolerant of partial names,
// out-of-order fragments and small typos ("DMOS" still finds DMSO).

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[n];
}

function isSubsequence(q: string, t: string): boolean {
  let i = 0;
  for (const ch of t) if (ch === q[i]) i++;
  return i === q.length;
}

/** 0 = no match; higher = better. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 1;
  if (t === q) return 100;
  if (t.startsWith(q)) return 90;
  if (t.includes(q)) return 80;
  // Any word starting with the query
  if (t.split(/[\s(),—-]+/).some((w) => w.startsWith(q))) return 70;
  // Small typos against each word (and the whole string for short names)
  const words = [t, ...t.split(/[\s(),—-]+/)];
  const tol = q.length <= 4 ? 1 : 2;
  if (words.some((w) => w && levenshtein(q, w.slice(0, Math.max(w.length, q.length))) <= tol)) return 55;
  if (words.some((w) => w && levenshtein(q, w) <= tol + 1)) return 45;
  // Characters appear in order (e.g. "fai" → "FAI (formamidinium iodide)")
  if (q.length >= 3 && isSubsequence(q, t)) return 30;
  return 0;
}

export function fuzzyFilter<T>(items: T[], query: string, key: (item: T) => string): T[] {
  if (!query.trim()) return items;
  return items
    .map((item) => ({ item, score: fuzzyScore(query, key(item)) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.item);
}
