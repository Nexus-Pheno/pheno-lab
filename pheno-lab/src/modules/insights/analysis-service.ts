import "server-only";
import { fmtBeijing } from "@/lib/datetime";

import { db } from "@/infrastructure/db/client";
import { chat, activeProvider } from "@/modules/ai/client";
import type { Actor } from "@/modules/authorization/actor";
import { experimentVisibilityScope } from "@/modules/authorization/scope";
import {
  METRICS,
  metricKeyOf,
  numish,
  type MetricKey,
} from "@/modules/experiments/summary-service";
import type { TestPlan } from "@/lib/library";

// Cross-experiment analysis: the technicians ask questions like "spin vs
// blade SAM across all batches — which is better, and what should we run
// next?" that no single experiment's record can answer. The model reads a
// deterministic digest of every visible experiment (variables, per-group
// aggregates computed here in code, conclusions) and writes an answer that
// must cite experiment codes. Same accuracy rules as the per-experiment
// summary: no outside data, no model arithmetic.

export type HistoryAnalysis = {
  text: string;
  model: string;
  experiments: number;
  generatedAt: string;
};

const fmt = (v: number) =>
  v
    .toPrecision(4)
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");

/** The most experiments one digest may carry — keeps the prompt bounded. */
const MAX_EXPERIMENTS = 80;
const CLIP = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

export async function analyzeHistory(
  actor: Actor,
  question: string,
  lang: "en" | "zh",
): Promise<HistoryAnalysis | null> {
  const q = question.trim();
  if (!q) return null;

  const rows = await db.experiment.findMany({
    // Real science only: test experiments would poison every comparison.
    where: { AND: [experimentVisibilityScope(actor, false)] },
    orderBy: { createdAt: "desc" },
    take: MAX_EXPERIMENTS,
    select: {
      code: true,
      title: true,
      status: true,
      createdAt: true,
      hypothesis: true,
      conclusion: true,
      metadata: true,
      createdBy: { select: { name: true } },
      samples: { select: { id: true, code: true, variationGroup: true } },
      steps: {
        orderBy: { position: "asc" },
        select: {
          name: true,
          process: { select: { name: true } },
          equipment: { select: { name: true, nickname: true } },
          materials: { select: { material: { select: { name: true } } } },
        },
      },
      characterizations: {
        select: {
          results: {
            where: {
              OR: [
                { runId: null },
                { run: { is: { status: { not: "CANCELLED" } } } },
              ],
            },
            select: { sampleId: true, metrics: true },
          },
        },
      },
    },
  });
  if (!rows.length) return null;

  const blocks: string[] = [];
  for (const exp of rows) {
    const plan = (exp.metadata as { testPlan?: TestPlan } | null)?.testPlan;
    const L: string[] = [];
    L.push(
      `### ${exp.code} — ${CLIP(exp.title, 80)} (${exp.status}, ${fmtBeijing(exp.createdAt, "date")}, by ${exp.createdBy.name})`,
    );

    // What was varied.
    for (const v of plan?.variables ?? []) {
      const values = plan!.groups
        .map(
          (g) =>
            `${g.label}${g.isControl ? "(control)" : ""}=${v.values[g.label] ?? "—"}`,
        )
        .join(", ");
      L.push(
        `varied "${v.parameter}"${v.unit ? ` [${v.unit}]` : ""}: ${values}`,
      );
    }

    // Process route and materials, one compact line each.
    if (exp.steps.length) {
      L.push(
        "route: " +
          exp.steps
            .map(
              (s) =>
                s.name +
                (s.equipment
                  ? ` [${s.equipment.nickname || s.equipment.name}]`
                  : ""),
            )
            .join(" → "),
      );
      const mats = [
        ...new Set(
          exp.steps.flatMap((s) => s.materials.map((m) => m.material.name)),
        ),
      ];
      if (mats.length) L.push(`materials: ${mats.join(", ")}`);
    }

    // Per-group JV aggregates, computed here — the model never does math.
    const byGroup = new Map<string, Record<MetricKey, number[]>>();
    const groupOf = new Map(
      exp.samples.map((s) => [s.id, s.variationGroup] as const),
    );
    for (const c of exp.characterizations) {
      for (const r of c.results) {
        const group = r.sampleId ? groupOf.get(r.sampleId) : null;
        if (!group) continue;
        const bucket =
          byGroup.get(group) ??
          byGroup.set(group, { pce: [], voc: [], jsc: [], ff: [] }).get(group)!;
        for (const [label, raw] of Object.entries(
          (r.metrics ?? {}) as Record<string, unknown>,
        )) {
          const key = metricKeyOf(label);
          const v = key ? numish(raw) : null;
          if (key && v !== null) bucket[key].push(v);
        }
      }
    }
    for (const [group, buckets] of [...byGroup.entries()].sort()) {
      const parts: string[] = [];
      for (const m of METRICS) {
        const vals = buckets[m];
        if (!vals.length) continue;
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        parts.push(
          `${m.toUpperCase()} mean=${fmt(mean)} best=${fmt(Math.max(...vals))} n=${vals.length}`,
        );
      }
      if (parts.length) L.push(`group ${group}: ${parts.join(" · ")}`);
    }
    if (!byGroup.size) L.push("(no measured JV results)");

    if (exp.hypothesis) L.push(`hypothesis: ${CLIP(exp.hypothesis, 200)}`);
    if (exp.conclusion) L.push(`conclusion: ${CLIP(exp.conclusion, 300)}`);
    blocks.push(L.join("\n"));
  }

  const system = [
    "You are a research analyst for a perovskite solar-cell laboratory.",
    "You will receive the lab's experiment history — every experiment's tested variables, process route, materials, pre-computed per-group JV aggregates (PCE %, Voc V, Jsc mA/cm², FF %), and recorded conclusions — followed by one question from the team.",
    "Answer the question using the history.",
    "",
    "Hard rules:",
    "- Use ONLY the records provided. Never invent, estimate, or recall values, materials, or experiments that are not present.",
    "- Cite the experiment code (e.g. 2026-001-26-3) for every claim so the reader can check it.",
    "- Quote the pre-computed aggregates exactly; do not recompute or round differently.",
    "- Comparisons across experiments are only as good as their shared conditions — when substrates, formulations or routes differ between the experiments being compared, say so explicitly as a caveat.",
    "- If the history cannot answer the question, say exactly what is missing.",
    "",
    "Structure the answer as short paragraphs (no markdown headings), in order:",
    "1. Direct answer to the question, with the strongest evidence.",
    "2. Supporting comparison — the relevant experiments with their exact numbers.",
    "3. Caveats — confounded variables, small sample counts, missing data.",
    "4. Recommended next experiments — the specific conditions to run that would settle the question, grounded in the gaps you just named.",
    "",
    lang === "zh"
      ? "Write in Simplified Chinese, at most about 1200 characters. Keep experiment codes, group labels, units and metric names (PCE, Voc, Jsc, FF) exactly as written."
      : "Write in English, at most about 800 words. Keep experiment codes, group labels, units and metric names exactly as written.",
  ].join("\n");

  const reply = await chat(
    actor.org,
    [
      { role: "system", content: system },
      {
        role: "user",
        content: `# Lab history (${rows.length} experiments, newest first)\n\n${blocks.join("\n\n")}\n\n# Question\n${CLIP(q, 1000)}`,
      },
    ],
    // Synchronous under the 60s Nginx window; the reasoning model spends
    // tokens thinking before the visible answer, so the cap stays generous.
    { maxTokens: 6000, temperature: 0, timeoutMs: 55_000 },
  );
  if (!reply?.trim()) return null;

  return {
    text: reply.trim(),
    model: (await activeProvider(actor.org))?.model ?? "unknown",
    experiments: rows.length,
    generatedAt: new Date().toISOString(),
  };
}
