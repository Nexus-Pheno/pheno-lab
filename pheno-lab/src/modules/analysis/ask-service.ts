import "server-only";

import { db } from "@/infrastructure/db/client";
import { fmtBeijing } from "@/lib/datetime";
import { activeProvider, chat } from "@/modules/ai/client";
import type { Actor } from "@/modules/authorization/actor";
import { recordUserAudit } from "@/modules/audit/writer";
import {
  buildTidyRows,
  hasAnyMetric,
  recipeConditions,
  variedConditions,
  type TidyRow,
} from "./dataset";
import { retrieveExperiments } from "./retrieval";
import { askSchema } from "./schema";
import {
  compareByCondition,
  detectAnomalies,
  perExperimentOutcomes,
  topCombos,
  untriedCombos,
  winCounts,
} from "./stats";

// Free-form analysis (0909批次改善使用反馈 §二): no picker, no fixed scope. The
// question chooses the experiments, the code computes every number, the
// model writes the reading and is asked to weigh factors together.
//
// Runs detached, like the per-experiment summary: retrieval plus a digest
// over 40 experiments plus a reasoning model will not always fit one
// request. The AnalysisRun row is what the page polls, and what the lab reads
// back later — analyses are org-wide, so the history is too.

const STALE_MS = 5 * 60_000;
const CLIP = (s: string, n: number) =>
  s.length > n ? s.slice(0, n - 1) + "…" : s;
const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2));

export type AnalysisRunRow = {
  id: string;
  question: string;
  lang: string;
  status: "RUNNING" | "DONE" | "FAILED";
  text: string;
  model: string;
  experiments: number;
  samples: number;
  experimentCodes: string[];
  requestedBy: string;
  startedAt: string;
  finishedAt: string | null;
};

function toRow(run: {
  id: string;
  question: string;
  lang: string;
  status: string;
  text: string;
  model: string;
  experiments: number;
  samples: number;
  experimentCodes: string[];
  startedAt: Date;
  finishedAt: Date | null;
  requestedBy: { name: string };
}): AnalysisRunRow {
  return {
    id: run.id,
    question: run.question,
    lang: run.lang,
    status: run.status as AnalysisRunRow["status"],
    text: run.text,
    model: run.model,
    experiments: run.experiments,
    samples: run.samples,
    experimentCodes: run.experimentCodes,
    requestedBy: run.requestedBy.name,
    startedAt: fmtBeijing(run.startedAt),
    finishedAt: run.finishedAt ? fmtBeijing(run.finishedAt) : null,
  };
}

const runSelect = {
  id: true,
  question: true,
  lang: true,
  status: true,
  text: true,
  model: true,
  experiments: true,
  samples: true,
  experimentCodes: true,
  startedAt: true,
  finishedAt: true,
  requestedBy: { select: { name: true } },
} as const;

export async function startAnalysisRun(
  actor: Actor,
  raw: unknown,
): Promise<AnalysisRunRow> {
  const input = askSchema.parse(raw);
  const run = await db.$transaction(async (tx) => {
    const created = await tx.analysisRun.create({
      data: {
        organizationId: actor.org,
        requestedById: actor.uid,
        question: input.question,
        lang: input.lang,
      },
      select: runSelect,
    });
    await recordUserAudit(tx, {
      actor,
      action: "analysis.asked",
      entityType: "AnalysisRun",
      entityId: created.id,
      metadata: { length: input.question.length },
    });
    return created;
  });

  void generate(actor, run.id, input.question, input.lang)
    .then((result) =>
      db.analysisRun.update({
        where: { id: run.id },
        data: result
          ? { status: "DONE", finishedAt: new Date(), ...result }
          : { status: "FAILED", finishedAt: new Date() },
      }),
    )
    .catch(() =>
      db.analysisRun
        .update({
          where: { id: run.id },
          data: { status: "FAILED", finishedAt: new Date() },
        })
        .catch(() => {}),
    );

  return toRow(run);
}

export async function getAnalysisRun(
  actor: Actor,
  id: string,
): Promise<AnalysisRunRow | null> {
  const run = await db.analysisRun.findFirst({
    where: { id, organizationId: actor.org },
    select: runSelect,
  });
  if (!run) return null;
  // A run marked running for longer than any generation takes has crashed.
  if (
    run.status === "RUNNING" &&
    Date.now() - run.startedAt.getTime() > STALE_MS
  ) {
    await db.analysisRun.updateMany({
      where: { id, status: "RUNNING" },
      data: { status: "FAILED", finishedAt: new Date() },
    });
    return toRow({ ...run, status: "FAILED", finishedAt: new Date() });
  }
  return toRow(run);
}

/** The lab's recent questions — shared, like the analysis itself. */
export async function listAnalysisRuns(
  actor: Actor,
  take = 20,
): Promise<AnalysisRunRow[]> {
  const rows = await db.analysisRun.findMany({
    where: { organizationId: actor.org },
    orderBy: { startedAt: "desc" },
    take,
    select: runSelect,
  });
  return rows.map(toRow);
}

// ---- generation --------------------------------------------------------------

async function generate(
  actor: Actor,
  runId: string,
  question: string,
  lang: "en" | "zh",
) {
  const retrieved = await retrieveExperiments(actor, question);
  if (retrieved.ids.length === 0) return null;

  const experiments = await db.experiment.findMany({
    where: { id: { in: retrieved.ids }, organizationId: actor.org },
    orderBy: { createdAt: "desc" },
    include: {
      createdBy: { select: { name: true } },
      project: { select: { name: true } },
      steps: {
        orderBy: { position: "asc" },
        select: {
          name: true,
          process: { select: { id: true, name: true } },
          parameters: {
            select: {
              name: true,
              unit: true,
              value: true,
              variations: { select: { variationGroup: true, value: true } },
            },
          },
          materials: { select: { material: { select: { name: true } } } },
        },
      },
      samples: {
        orderBy: { code: "asc" },
        select: {
          id: true,
          code: true,
          variationGroup: true,
          results: { select: { metrics: true } },
        },
      },
    },
  });

  const rows = buildTidyRows(experiments, { recipe: true }).filter(
    hasAnyMetric,
  );
  const digest = buildDigest(question, retrieved, experiments, rows);

  const reply = await chat(
    actor.org,
    [
      { role: "system", content: systemPrompt(lang) },
      { role: "user", content: digest },
    ],
    { maxTokens: 8000, temperature: 0, timeoutMs: 240_000 },
  );
  if (!reply) return null;
  return {
    text: reply.trim(),
    model: (await activeProvider(actor.org))?.model ?? "unknown",
    experiments: experiments.length,
    samples: rows.length,
    experimentCodes: experiments.map((e) => e.code),
  };
}

type Exp = Awaited<ReturnType<typeof db.experiment.findMany>>[number] & {
  createdBy: { name: string };
  project: { name: string } | null;
  steps: {
    name: string;
    process: { id: string; name: string };
    parameters: {
      name: string;
      unit: string;
      value: string;
      variations: { variationGroup: string; value: string }[];
    }[];
    materials: { material: { name: string } }[];
  }[];
  samples: {
    id: string;
    code: string;
    variationGroup: string | null;
    results: { metrics: unknown }[];
  }[];
};

function buildDigest(
  question: string,
  retrieved: { terms: string[]; fallback: boolean },
  experiments: Exp[],
  rows: TidyRow[],
): string {
  const L: string[] = [];
  L.push(`Question: ${question}`);
  L.push(
    `Retrieved ${experiments.length} experiments${retrieved.terms.length ? ` matching: ${retrieved.terms.join(", ")}` : ""}${retrieved.fallback ? " (nothing matched the question directly; these are the newest measured experiments)" : ""}; ${rows.length} measured samples.`,
  );

  // Conditions: what differs across this set, most widely tried first.
  const catalog = new Map<
    string,
    {
      label: string;
      process: string;
      unit: string;
      source: string;
      experiments: Set<string>;
      values: Set<string>;
    }
  >();
  for (const exp of experiments) {
    const varied = variedConditions(exp);
    const seen = new Set(varied.map((c) => c.key));
    for (const c of [
      ...varied,
      ...recipeConditions(exp).filter((c) => !seen.has(c.key)),
    ]) {
      const known = catalog.get(c.key) ?? {
        label: c.label,
        process: c.process,
        unit: c.unit,
        source: c.source,
        experiments: new Set(),
        values: new Set(),
      };
      known.experiments.add(exp.code);
      if (c.source === "varied") known.source = "varied";
      catalog.set(c.key, known);
    }
  }
  for (const row of rows)
    for (const [k, v] of Object.entries(row.conditions))
      catalog.get(k)?.values.add(v);
  const conditions = [...catalog.entries()]
    .filter(([, c]) => c.values.size >= 2)
    .sort(
      (a, b) =>
        b[1].experiments.size - a[1].experiments.size ||
        b[1].values.size - a[1].values.size,
    )
    .slice(0, 8);
  const labelOf = (key: string) => {
    const c = catalog.get(key);
    return c
      ? `${c.process ? c.process + " · " : ""}${c.label}${c.unit ? ` [${c.unit}]` : ""}`
      : key;
  };

  L.push("", "## Conditions that differ across these experiments");
  if (conditions.length === 0)
    L.push(
      "(none — the retrieved experiments share one recipe or carry no structured conditions)",
    );
  for (const [key, c] of conditions)
    L.push(
      `${labelOf(key)} — ${c.source === "varied" ? "varied inside experiments" : "differs between recipes"}; ${c.values.size} values across ${c.experiments.size} experiments`,
    );

  for (const [key] of conditions) {
    const arms = compareByCondition(rows, key, "pce").slice(0, 8);
    if (arms.length < 2) continue;
    L.push("", `## ${labelOf(key)} — pooled PCE`);
    L.push("value | n | experiments | mean | median | best | sd");
    for (const arm of arms)
      L.push(
        `${arm.value} | ${arm.summary.n} | ${arm.experiments.length} | ${fmt(arm.summary.mean)} | ${fmt(arm.summary.median)} | ${fmt(arm.summary.best)} | ${fmt(arm.summary.sd)}`,
      );
    const outcomes = perExperimentOutcomes(rows, key, "pce");
    if (outcomes.length > 0) {
      L.push("Inside each experiment (rest of the process held constant):");
      for (const o of outcomes.slice(0, 12))
        L.push(
          `  ${o.experimentCode} (${o.date}): ${o.arms.map((a) => `${a.value}=${fmt(a.mean)} n=${a.n}`).join(", ")} -> best ${o.winner}`,
        );
      const wins = winCounts(outcomes);
      L.push(
        `  Win counts: ${wins.map((w) => `${w.value} ${w.wins}/${w.appearances}`).join("; ")}`,
      );
    } else {
      L.push(
        "No experiment compared two values of this condition internally — the pooled rows come from different batches.",
      );
    }
  }

  const comboKeys = conditions.slice(0, 3).map(([key]) => key);
  const combos = topCombos(rows, comboKeys, "pce", 6);
  if (combos.length > 0) {
    L.push("", "## Best combinations actually run (>=2 devices), by mean PCE");
    for (const combo of combos)
      L.push(
        `${comboKeys.map((k) => `${labelOf(k)}=${combo.conditions[k]}`).join(" + ")} -> mean ${fmt(combo.summary.mean)}, best ${fmt(combo.summary.best)}, n=${combo.summary.n}, in ${combo.experiments.join(", ")}`,
      );
  }
  if (comboKeys.length >= 2) {
    const gaps = untriedCombos(rows, comboKeys[0], comboKeys[1]);
    if (gaps.length > 0) {
      L.push(
        "",
        `## Never run together: ${labelOf(comboKeys[0])} x ${labelOf(comboKeys[1])}`,
      );
      for (const g of gaps) L.push(`${g.a} + ${g.b}`);
    }
  }

  const flags = detectAnomalies(rows).slice(0, 15);
  if (flags.length > 0) {
    L.push("", "## Flags computed from the data");
    for (const f of flags) {
      if (f.kind === "champion")
        L.push(
          `Champion device ${f.sample} (group ${f.group ?? "-"}) at PCE ${fmt(f.value)}.`,
        );
      if (f.kind === "outlier")
        L.push(
          `${f.sample} (group ${f.group}): PCE ${fmt(f.value)} outside its group's range (median ${fmt(f.median)}).`,
        );
    }
  }

  L.push("", "## The experiments");
  for (const exp of experiments) {
    const measured = rows.filter((r) => r.experimentId === exp.id);
    const pce = measured
      .map((r) => r.metrics.pce)
      .filter((v): v is number => v !== undefined);
    const best = pce.length
      ? ` best PCE ${fmt(Math.max(...pce))} of ${pce.length}`
      : " (no measured PCE)";
    const date = new Date(exp.createdAt.getTime() + 8 * 3_600_000)
      .toISOString()
      .slice(0, 10);
    L.push(
      `### ${exp.code} — ${CLIP(exp.title, 80)} (${date}, ${exp.project?.name ?? "no team"}, by ${exp.createdBy.name})${best}`,
    );
    const recipe = exp.steps
      .map(
        (s) =>
          `${s.process.name}${s.materials.length ? `: ${s.materials.map((m) => m.material.name).join(" + ")}` : ""}`,
      )
      .join(" → ");
    if (recipe) L.push(`recipe: ${CLIP(recipe, 300)}`);
    for (const c of variedConditions(exp))
      L.push(
        `varied ${c.label}: ${Object.entries(c.byGroup)
          .map(([g, v]) => `${g}=${v}`)
          .join(", ")}`,
      );
    if (exp.hypothesis.trim())
      L.push(`hypothesis: ${CLIP(exp.hypothesis.trim(), 200)}`);
    if (exp.conclusion.trim())
      L.push(`conclusion: ${CLIP(exp.conclusion.trim(), 300)}`);
  }
  return L.join("\n");
}

// The accuracy of this feature lives in this prompt — tune it here. Keep the
// hard rules: no outside data, no recomputation, per-batch repetition over
// pooled means, and interactions named as interactions.
function systemPrompt(lang: "en" | "zh"): string {
  return [
    "You are a meticulous research assistant for a perovskite solar-cell laboratory.",
    "You will receive: a question; tables the laboratory's own software computed from the experiments it retrieved for that question (conditions that differ across them, pooled comparisons, the same comparisons repeated inside each experiment, win counts, the best combinations actually run, pairs never run together, flags); and a short record of each experiment with its recipe, hypothesis and conclusion.",
    "",
    "Hard rules:",
    "- Use ONLY the numbers and facts given. Never invent, estimate or recall values, materials or experiments that are not present.",
    "- Do not recompute or re-round the aggregates; quote them as given.",
    "- A result that repeats INSIDE several experiments is strong evidence. A difference that appears only in a pooled table is weak: those samples come from different batches that differed in other ways too. When a condition 'differs between recipes', say explicitly which other conditions changed alongside it in the same experiments before attributing an effect to it.",
    "- Look for interactions: where the best combinations table or the per-experiment records show that a condition helps under one recipe and not another, say so and name both conditions.",
    "- Cite experiment codes (e.g. 2026-001-26-3) for every claim that rests on specific batches.",
    "- Small n is a real limit. Name it rather than writing around it.",
    "- Treat flagged measurement artifacts as caveats, not device performance.",
    "- Be neutral: report negative and inconclusive outcomes plainly. If the retrieved experiments cannot answer the question, say what is missing.",
    "",
    "Structure the answer as short paragraphs, no markdown headings, in this order:",
    "1. The direct answer, with the numbers it rests on.",
    "2. Which conclusions repeat across batches, which conflict, and what else differed between the batches being compared.",
    "3. Interactions between factors, with the combinations and codes that show them, and how confident the data allows you to be.",
    "4. What to run next: prefer the listed untried pairs and the comparisons where n is too small; be specific about conditions and values.",
    "",
    lang === "zh"
      ? "Write in Simplified Chinese, at most about 1500 characters. Keep experiment codes, sample codes, units and metric names (PCE, Voc, Jsc, FF) exactly as written."
      : "Write in English, at most about 1000 words. Keep experiment codes, sample codes, units and metric names exactly as written.",
  ].join("\n");
}
