import type { MetricKey } from "@/modules/experiments/summary-service";
import type { TidyRow } from "./dataset";

// Every number the lab is shown — and every number the model is later given —
// is computed here, in code. Nothing downstream does arithmetic on raw data.

export type Summary = {
  n: number;
  mean: number;
  best: number;
  worst: number;
  median: number;
  /** Sample standard deviation; 0 when n < 2. */
  sd: number;
};

export function summarize(values: number[]): Summary | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  const sd =
    n < 2
      ? 0
      : Math.sqrt(sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  return {
    n,
    mean,
    best: sorted[n - 1],
    worst: sorted[0],
    median: quantile(sorted, 0.5),
    sd,
  };
}

/** Linear-interpolated quantile over an ascending array. */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1];
  return next === undefined
    ? sorted[base]
    : sorted[base] + rest * (next - sorted[base]);
}

/**
 * Group the dataset by the value of one varied condition.
 *
 * This is the join the old digest could not make: "旋涂" in one batch and
 * "旋涂" in another are the same condition, so their samples pool and the
 * comparison finally spans experiments instead of restating one of them.
 */
export type ConditionArm = {
  value: string;
  summary: Summary;
  experiments: string[];
  samples: { value: number; code: string }[];
};

export function compareByCondition(
  rows: TidyRow[],
  conditionKey: string,
  metric: MetricKey,
): ConditionArm[] {
  const arms = new Map<
    string,
    { values: { value: number; code: string }[]; experiments: Set<string> }
  >();
  for (const row of rows) {
    const value = row.conditions[conditionKey];
    const measured = row.metrics[metric];
    if (value === undefined || measured === undefined) continue;
    const arm = arms.get(value) ?? { values: [], experiments: new Set() };
    arm.values.push({ value: measured, code: row.sampleCode });
    arm.experiments.add(row.experimentCode);
    arms.set(value, arm);
  }
  return [...arms.entries()]
    .map(([value, arm]) => ({
      value,
      summary: summarize(arm.values.map((v) => v.value))!,
      experiments: [...arm.experiments].sort(),
      samples: arm.values,
    }))
    .sort((a, b) => b.summary.mean - a.summary.mean);
}

/** Per-batch view of one condition: did it win in each experiment separately? */
export type BatchOutcome = {
  experimentCode: string;
  experimentTitle: string;
  date: string;
  arms: { value: string; mean: number; n: number }[];
  winner: string | null;
};

export function perExperimentOutcomes(
  rows: TidyRow[],
  conditionKey: string,
  metric: MetricKey,
): BatchOutcome[] {
  const byExperiment = new Map<string, TidyRow[]>();
  for (const row of rows) {
    if (row.conditions[conditionKey] === undefined) continue;
    if (row.metrics[metric] === undefined) continue;
    const list = byExperiment.get(row.experimentCode) ?? [];
    list.push(row);
    byExperiment.set(row.experimentCode, list);
  }

  const out: BatchOutcome[] = [];
  for (const [experimentCode, list] of byExperiment) {
    const arms = compareByCondition(list, conditionKey, metric).map((arm) => ({
      value: arm.value,
      mean: arm.summary.mean,
      n: arm.summary.n,
    }));
    // A single arm is not a comparison — the batch tried one thing.
    if (arms.length < 2) continue;
    out.push({
      experimentCode,
      experimentTitle: list[0].experimentTitle,
      date: list[0].date,
      arms,
      winner: arms[0].value,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** How often each value of a condition came out on top, batch by batch. */
export function winCounts(
  outcomes: BatchOutcome[],
): { value: string; wins: number; appearances: number }[] {
  const tally = new Map<string, { wins: number; appearances: number }>();
  for (const outcome of outcomes) {
    for (const arm of outcome.arms) {
      const row = tally.get(arm.value) ?? { wins: 0, appearances: 0 };
      row.appearances += 1;
      if (outcome.winner === arm.value) row.wins += 1;
      tally.set(arm.value, row);
    }
  }
  return [...tally.entries()]
    .map(([value, row]) => ({ value, ...row }))
    .sort((a, b) => b.wins - a.wins || b.appearances - a.appearances);
}

// ---- anomalies -------------------------------------------------------------

export type Anomaly =
  | { kind: "champion"; sample: string; group: string | null; value: number }
  | {
      kind: "negativeResistance";
      sample: string;
      metric: "Rsh" | "Rs";
      value: number;
    }
  | {
      kind: "outlier";
      sample: string;
      group: string;
      value: number;
      median: number;
    };

export type RawScan = {
  serial: string;
  metrics: unknown;
  sample: { code: string; variationGroup: string | null } | null;
};

/**
 * Deterministic flags a reader would otherwise have to notice by eye.
 *
 * Outliers use Tukey fences (1.5×IQR) rather than standard deviations: lab
 * groups run 4–8 devices, where one bad contact drags the mean and the
 * deviation with it, and the point is precisely to catch that one device.
 */
export type AnomalyRow = {
  sampleCode: string;
  group: string | null;
  metrics: Partial<Record<MetricKey, number>>;
};

export function detectAnomalies(
  rows: AnomalyRow[],
  scans: RawScan[] = [],
): Anomaly[] {
  const flags: Anomaly[] = [];

  let champion: { sample: string; group: string | null; value: number } | null =
    null;
  for (const row of rows) {
    const pce = row.metrics.pce;
    if (pce === undefined) continue;
    if (!champion || pce > champion.value)
      champion = { sample: row.sampleCode, group: row.group, value: pce };
  }
  if (champion) flags.push({ kind: "champion", ...champion });

  // Negative Rsh/Rs is physically impossible: a measurement artifact, not a
  // device property. Worth saying out loud, because the same scan's PCE is
  // still usable and people otherwise throw the whole sample away.
  const seen = new Set<string>();
  for (const scan of scans) {
    const metrics = (scan.metrics ?? {}) as Record<string, unknown>;
    for (const [key, label] of [
      ["rsh", "Rsh"],
      ["rs", "Rs"],
    ] as const) {
      const raw = metrics[key];
      const value = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(value) || value >= 0) continue;
      const sample = scan.sample?.code ?? scan.serial;
      const id = `${sample}|${label}`;
      if (seen.has(id)) continue;
      seen.add(id);
      flags.push({ kind: "negativeResistance", sample, metric: label, value });
    }
  }

  const byGroup = new Map<string, { value: number; code: string }[]>();
  for (const row of rows) {
    const pce = row.metrics.pce;
    if (pce === undefined || !row.group) continue;
    const list = byGroup.get(row.group) ?? [];
    list.push({ value: pce, code: row.sampleCode });
    byGroup.set(row.group, list);
  }
  for (const [group, list] of [...byGroup.entries()].sort()) {
    if (list.length < 4) continue;
    const sorted = [...list].sort((a, b) => a.value - b.value);
    const values = sorted.map((x) => x.value);
    const q1 = quantile(values, 0.25);
    const q3 = quantile(values, 0.75);
    const iqr = q3 - q1;
    if (iqr === 0) continue;
    const median = quantile(values, 0.5);
    for (const item of sorted) {
      if (item.value < q1 - 1.5 * iqr || item.value > q3 + 1.5 * iqr)
        flags.push({
          kind: "outlier",
          sample: item.code,
          group,
          value: item.value,
          median,
        });
    }
  }

  return flags;
}

// ---- combinations ----------------------------------------------------------

export type Combo = {
  /** Condition key to value: the full recipe this set of samples shared. */
  conditions: Record<string, string>;
  summary: Summary;
  experiments: string[];
};

/**
 * Rank the condition combinations actually run, best first.
 *
 * "Which combination gave the best cells" is the question the reporter answers
 * by hand with a pivot table. A combination only counts when at least two
 * devices ran it — a single champion device is luck until it repeats.
 */
export function topCombos(
  rows: TidyRow[],
  conditionKeys: string[],
  metric: MetricKey,
  limit = 5,
): Combo[] {
  if (conditionKeys.length === 0) return [];
  const buckets = new Map<
    string,
    {
      conditions: Record<string, string>;
      values: number[];
      experiments: Set<string>;
    }
  >();
  for (const row of rows) {
    const measured = row.metrics[metric];
    if (measured === undefined) continue;
    const conditions: Record<string, string> = {};
    let complete = true;
    for (const key of conditionKeys) {
      const value = row.conditions[key];
      if (value === undefined) {
        complete = false;
        break;
      }
      conditions[key] = value;
    }
    if (!complete) continue;
    const id = conditionKeys.map((key) => conditions[key]).join(" | ");
    const bucket = buckets.get(id) ?? {
      conditions,
      values: [],
      experiments: new Set<string>(),
    };
    bucket.values.push(measured);
    bucket.experiments.add(row.experimentCode);
    buckets.set(id, bucket);
  }
  return [...buckets.values()]
    .filter((bucket) => bucket.values.length >= 2)
    .map((bucket) => ({
      conditions: bucket.conditions,
      summary: summarize(bucket.values)!,
      experiments: [...bucket.experiments].sort(),
    }))
    .sort((a, b) => b.summary.mean - a.summary.mean)
    .slice(0, limit);
}

/**
 * Combinations of two conditions the lab has never run together.
 *
 * Computed, not guessed: the cross product of the values already tried, minus
 * the pairs that appear in the data. This is what turns "what should we try
 * next" from an opinion into a list.
 */
export function untriedCombos(
  rows: TidyRow[],
  keyA: string,
  keyB: string,
  limit = 8,
): { a: string; b: string }[] {
  const valuesA = new Set<string>();
  const valuesB = new Set<string>();
  const tried = new Set<string>();
  for (const row of rows) {
    const a = row.conditions[keyA];
    const b = row.conditions[keyB];
    if (a !== undefined) valuesA.add(a);
    if (b !== undefined) valuesB.add(b);
    if (a !== undefined && b !== undefined) tried.add(a + " >< " + b);
  }
  const gaps: { a: string; b: string }[] = [];
  for (const a of [...valuesA].sort()) {
    for (const b of [...valuesB].sort()) {
      if (!tried.has(a + " >< " + b)) gaps.push({ a, b });
    }
  }
  return gaps.slice(0, limit);
}
