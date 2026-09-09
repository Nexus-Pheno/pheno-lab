import "server-only";

import { activeProvider, chat } from "@/modules/ai/client";
import type { Actor } from "@/modules/authorization/actor";
import { fmtBeijing } from "@/lib/datetime";
import { loadAnalysisDataset } from "./query";
import { analysisQuestionSchema } from "./schema";
import {
  compareByCondition,
  detectAnomalies,
  perExperimentOutcomes,
  topCombos,
  untriedCombos,
  winCounts,
} from "./stats";

// The AI reading of the cross-experiment view.
//
// The model is handed the TABLES THIS APP COMPUTED — pooled means, per-batch
// outcomes, win counts, ranked combinations, untried pairs — and never raw
// curves or per-scan data. Everything numeric is decided in stats.ts, so the
// narrative can be wrong about emphasis but not about arithmetic, and a
// missing or failing provider degrades to the deterministic tables above it
// rather than to invented science.
//
// The whole prompt is a few kilobytes regardless of how many experiments are
// in scope, which is what makes a single synchronous call viable here.

const fmt = (value: number) =>
  Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(2);

export type AnalysisReading = {
  text: string;
  model: string;
  experiments: number;
  samples: number;
  generatedAt: string;
};

export async function readAnalysis(
  actor: Actor,
  raw: unknown,
): Promise<AnalysisReading | null> {
  const input = analysisQuestionSchema.parse(raw);
  const dataset = await loadAnalysisDataset(actor, input.scope);
  const conditionKey = input.scope.condition;
  const condition = dataset.conditions.find((c) => c.key === conditionKey);
  if (!condition || dataset.rows.length === 0) return null;

  const metric = input.scope.metric;
  const arms = compareByCondition(dataset.rows, condition.key, metric);
  const outcomes = perExperimentOutcomes(dataset.rows, condition.key, metric);
  const wins = winCounts(outcomes);
  const anomalies = detectAnomalies(dataset.rows);

  // The other conditions worth crossing with this one, most-used first.
  const partners = dataset.conditions
    .filter((c) => c.key !== condition.key)
    .slice(0, 2);
  const comboKeys = [condition.key, ...partners.map((c) => c.key)];
  const combos = topCombos(dataset.rows, comboKeys, metric, 5);
  const gaps = partners[0]
    ? untriedCombos(dataset.rows, condition.key, partners[0].key)
    : [];

  const labelOf = (key: string) => {
    const found = dataset.conditions.find((c) => c.key === key);
    return found
      ? `${found.process ? found.process + " " : ""}${found.label}`
      : key;
  };

  const L: string[] = [];
  L.push(
    `Scope: ${dataset.experiments} experiments, ${dataset.rows.length} measured samples.`,
  );
  if (input.scope.from || input.scope.to)
    L.push(
      `Date range: ${input.scope.from ?? "start"} to ${input.scope.to ?? "now"}.`,
    );
  if (dataset.truncated)
    L.push(
      "NOTE: capped at the 400 most recent experiments — say so if it matters.",
    );
  L.push(
    `Condition under study: "${labelOf(condition.key)}"${condition.unit ? ` [${condition.unit}]` : ""}. Metric: ${metric.toUpperCase()}.`,
  );

  L.push("", "## Pooled across all experiments in scope");
  L.push("value | n | experiments | mean | median | best | sd");
  for (const arm of arms)
    L.push(
      `${arm.value} | ${arm.summary.n} | ${arm.experiments.length} | ${fmt(arm.summary.mean)} | ${fmt(arm.summary.median)} | ${fmt(arm.summary.best)} | ${fmt(arm.summary.sd)}`,
    );

  L.push(
    "",
    "## Inside each experiment (the rest of the process held constant)",
  );
  if (outcomes.length === 0)
    L.push("(no experiment compared two values of this condition)");
  for (const outcome of outcomes)
    L.push(
      `${outcome.experimentCode} (${outcome.date}): ${outcome.arms.map((a) => `${a.value}=${fmt(a.mean)} n=${a.n}`).join(", ")} -> best: ${outcome.winner}`,
    );
  if (wins.length > 0)
    L.push(
      `Win counts: ${wins.map((w) => `${w.value} won ${w.wins} of ${w.appearances}`).join("; ")}`,
    );

  if (combos.length > 0) {
    L.push(
      "",
      `## Best combinations run (>=2 devices each), by mean ${metric.toUpperCase()}`,
    );
    for (const combo of combos)
      L.push(
        `${comboKeys.map((key) => `${labelOf(key)}=${combo.conditions[key]}`).join(" + ")} -> mean ${fmt(combo.summary.mean)}, best ${fmt(combo.summary.best)}, n=${combo.summary.n}, in ${combo.experiments.join(", ")}`,
      );
  }

  if (gaps.length > 0) {
    L.push(
      "",
      `## Pairs never run together: "${labelOf(condition.key)}" x "${labelOf(partners[0].key)}"`,
    );
    for (const gap of gaps) L.push(`${gap.a} + ${gap.b}`);
  }

  if (anomalies.length > 0) {
    L.push("", "## Flags computed from the data");
    for (const flag of anomalies.slice(0, 20)) {
      if (flag.kind === "champion")
        L.push(
          `Champion device ${flag.sample} (group ${flag.group ?? "-"}) at PCE ${fmt(flag.value)}.`,
        );
      if (flag.kind === "negativeResistance")
        L.push(
          `${flag.sample}: ${flag.metric}=${fmt(flag.value)} is negative — measurement artifact, not a device property; its PCE/Voc/Jsc/FF stay valid.`,
        );
      if (flag.kind === "outlier")
        L.push(
          `${flag.sample} (group ${flag.group}): PCE ${fmt(flag.value)} outside its group's range (median ${fmt(flag.median)}).`,
        );
    }
  }

  const reply = await chat(
    actor.org,
    [
      { role: "system", content: systemPrompt(input.lang) },
      {
        role: "user",
        content: `Question: ${input.question}\n\n${L.join("\n")}`,
      },
    ],
    // Generous cap: reasoning models spend tokens thinking before the visible
    // answer. Synchronous under the 60s proxy window, like the data-page ask.
    { maxTokens: 6000, temperature: 0, timeoutMs: 55_000 },
  );
  if (!reply) return null;

  return {
    text: reply.trim(),
    model: (await activeProvider(actor.org))?.model ?? "unknown",
    experiments: dataset.experiments,
    samples: dataset.rows.length,
    generatedAt: fmtBeijing(new Date()),
  };
}

// The accuracy of this feature lives in this prompt — tune it here, not in the
// transport layer. Keep the hard rules: no outside data, no recomputation, and
// per-batch repetition treated as stronger evidence than a pooled mean.
function systemPrompt(lang: "en" | "zh"): string {
  return [
    "You are a meticulous research assistant for a perovskite solar-cell laboratory.",
    "You will receive tables the laboratory's own software has already computed from its full experiment history: a pooled comparison of one process condition, the same comparison repeated inside each experiment, win counts, the best condition combinations actually run, pairs never yet run together, and flags.",
    "",
    "Hard rules:",
    "- Use ONLY the numbers in these tables. Never invent, estimate, or recall values, materials or experiments that are not present.",
    "- Do not recompute or re-round the aggregates; quote them as given.",
    "- A result that repeats INSIDE several experiments is strong evidence. A difference that only appears in the pooled table is weak: those samples come from different batches that differed in many other ways. Say which kind of evidence each claim rests on.",
    "- Cite experiment codes (e.g. 2026-001-26-3) for every claim that comes from specific batches.",
    "- Small n is a real limit. Name it rather than writing around it.",
    "- Treat flagged measurement artifacts as caveats, not as device performance.",
    "- Be neutral: report negative and inconclusive outcomes plainly.",
    "",
    "Structure the answer as short paragraphs, no markdown headings, in this order:",
    "1. The direct answer to the question, with the numbers it rests on.",
    "2. Which conclusions repeat across batches, and which conflict between them.",
    "3. The best combinations run so far, and how confident the data allows you to be.",
    "4. What to run next: prefer the listed untried pairs and the comparisons where n is too small to conclude. Be specific about the condition and the values.",
    "",
    lang === "zh"
      ? "Write in Simplified Chinese, at most about 1200 characters. Keep experiment codes, sample codes, units and metric names (PCE, Voc, Jsc, FF) exactly as written."
      : "Write in English, at most about 800 words. Keep experiment codes, sample codes, units and metric names exactly as written.",
  ].join("\n");
}
