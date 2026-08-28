import "server-only";

import type { Prisma } from "@prisma/client";
import { db } from "@/infrastructure/db/client";
import type { Actor } from "@/modules/authorization/actor";
import { activeProvider, chat } from "@/modules/ai/client";
import { recordUserAudit } from "@/modules/audit/writer";
import type { TestPlan } from "@/lib/library";
import { assertEdit } from "./access";
import { experimentIdSchema } from "./schema";
import { getReportExperiment } from "./query";

// AI-assisted experiment summary. The model reads a deterministic digest of
// the full scientific record — hypothesis, plan, every process step with its
// equipment and materials, execution deviations, and measured results — and
// writes an analytical summary the scientist reviews before their conclusion.
//
// Accuracy rules that shape this file:
// - All numbers the model sees are computed here, in code. Group means and
//   bests are pre-aggregated so the model never does arithmetic.
// - The prompt forbids outside knowledge and invented values; anything not in
//   the digest is "not recorded".
// - The output is advisory text stored in metadata; it never feeds back into
//   any deterministic pipeline (see modules/ai/client.ts).

type ReportExperiment = NonNullable<
  Awaited<ReturnType<typeof getReportExperiment>>
>;

export type AiSummary = {
  text: string;
  lang: "en" | "zh";
  model: string;
  generatedAt: string;
};

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const fmt = (v: number) =>
  v
    .toPrecision(4)
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");

/** Per-group aggregates of the JV metrics scientists actually compare. */
function groupStats(exp: ReportExperiment): string[] {
  const METRICS = ["pce", "voc", "jsc", "ff"] as const;
  const byGroup = new Map<string, Record<string, number[]>>();
  for (const c of exp.characterizations) {
    for (const r of c.results) {
      const sample = exp.samples.find((s) => s.id === r.sampleId);
      if (!sample?.variationGroup) continue;
      const metrics = (r.metrics ?? {}) as Record<string, unknown>;
      const bucket =
        byGroup.get(sample.variationGroup) ??
        byGroup
          .set(
            sample.variationGroup,
            Object.fromEntries(METRICS.map((m) => [m, []])),
          )
          .get(sample.variationGroup)!;
      for (const m of METRICS) {
        const v = num(metrics[m]);
        if (v !== null) bucket[m].push(v);
      }
    }
  }
  const lines: string[] = [];
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
    if (parts.length) lines.push(`Group ${group}: ${parts.join(" · ")}`);
  }
  return lines;
}

/** Everything the model is allowed to know, as compact labeled plain text. */
function buildDigest(exp: ReportExperiment): string {
  const plan = (exp.metadata as { testPlan?: TestPlan } | null)?.testPlan;
  const L: string[] = [];
  const section = (title: string) => L.push("", `## ${title}`);

  L.push(`Experiment ${exp.code} — ${exp.title}`);
  L.push(
    `Status: ${exp.status} · Owner: ${exp.createdBy.name}` +
      (exp.assignee ? ` · Assignee: ${exp.assignee.name}` : ""),
  );
  if (exp.campaign) L.push(`Campaign: ${exp.campaign}`);

  section("Scientific framing");
  L.push(`Observation: ${exp.observation || "(not recorded)"}`);
  L.push(`Problem: ${exp.problem || "(not recorded)"}`);
  L.push(`Hypothesis: ${exp.hypothesis || "(not recorded)"}`);
  if (exp.conclusion) L.push(`Existing conclusion draft: ${exp.conclusion}`);

  section("Test plan");
  if (plan) {
    for (const v of plan.variables) {
      const values = plan.groups
        .map(
          (g) =>
            `${g.label}${g.isControl ? "(control)" : ""}=${v.values[g.label] ?? "—"}`,
        )
        .join(", ");
      L.push(
        `Variable "${v.parameter}"${v.unit ? ` [${v.unit}]` : ""} (${v.kind}): ${values}`,
      );
    }
    L.push(
      "Groups: " +
        plan.groups
          .map(
            (g) =>
              `${g.label}${g.isControl ? " (control)" : ""}: ${g.samples} samples`,
          )
          .join(" · "),
    );
    if (plan.substrates?.materialName)
      L.push(
        `Substrate: ${plan.substrates.materialName} × ${plan.substrates.count}`,
      );
  } else {
    L.push("(no test plan recorded)");
  }
  const trashed = exp.samples.filter(
    (s) => plan?.assignments?.[s.code] === "ERROR",
  );
  if (trashed.length)
    L.push(
      `Scrapped substrates: ${trashed
        .map((s) => `${s.code}${s.note ? ` (${s.note})` : ""}`)
        .join(", ")}`,
    );

  section("Process flow (as planned)");
  for (const s of exp.steps) {
    const eq = s.equipment
      ? s.equipment.nickname
        ? `${s.equipment.nickname} (${s.equipment.name})`
        : s.equipment.name
      : "unspecified equipment";
    L.push(
      `Step ${s.position + 1}: ${s.name} — ${eq}` +
        (s.environment ? ` — env: ${s.environment.name}` : ""),
    );
    for (const m of s.materials)
      L.push(
        `  material: ${m.material.name}${m.amount ? ` — ${m.amount}` : ""}`,
      );
    for (const p of s.parameters) {
      const varied = p.variations.length
        ? ` (varied: ${p.variations.map((x) => `${x.variationGroup}=${x.value}`).join(", ")})`
        : "";
      L.push(
        `  param: ${p.name} = ${p.value}${p.unit ? ` ${p.unit}` : ""}${varied}`,
      );
    }
    if (s.notes) L.push(`  note: ${s.notes}`);
  }
  if (!exp.steps.length) L.push("(no steps recorded)");

  section("Characterization plan");
  for (const c of exp.characterizations) {
    L.push(
      `${c.name}` +
        (c.equipment ? ` — ${c.equipment.name}` : "") +
        (c.sampleScope ? ` — scope: ${c.sampleScope}` : ""),
    );
  }
  if (!exp.characterizations.length) L.push("(none)");

  section("Execution deviations and lab notes");
  let deviations = 0;
  for (const run of exp.runs) {
    for (const x of run.executions) {
      const step = exp.steps.find((s) => s.id === x.stepId);
      const sample = exp.samples.find((s) => s.id === x.sampleId);
      if (!step || !sample) continue;
      const actuals = (x.actuals ?? {}) as Record<string, string>;
      const diffs: string[] = [];
      for (const p of step.parameters) {
        const planned = sample.variationGroup
          ? (p.variations.find(
              (v) => v.variationGroup === sample.variationGroup,
            )?.value ?? p.value)
          : p.value;
        const actual = actuals[p.name];
        if (actual !== undefined && actual !== planned)
          diffs.push(
            `${p.name}: planned ${planned} → actual ${actual} ${p.unit}`.trim(),
          );
      }
      if (diffs.length || x.note || x.flagged) {
        deviations += 1;
        L.push(
          `${step.name} / ${sample.code}${x.flagged ? " [FLAGGED]" : ""}: ` +
            [diffs.join("; "), x.note].filter(Boolean).join(" — "),
        );
      }
    }
  }
  if (!deviations) L.push("(none recorded — execution matched the plan)");

  section("Measured results");
  const stats = groupStats(exp);
  if (stats.length) {
    L.push(
      "Pre-computed per-group aggregates (PCE %, Voc V, Jsc mA/cm², FF %):",
    );
    L.push(...stats);
  }
  for (const c of exp.characterizations) {
    const rows = c.results
      .filter((r) => r.sampleId)
      .map((r) => {
        const sample = exp.samples.find((s) => s.id === r.sampleId);
        const metrics = Object.entries(
          (r.metrics ?? {}) as Record<string, unknown>,
        )
          .filter(([, v]) => num(v) !== null || (typeof v === "string" && v))
          .map(([k, v]) => `${k}=${typeof v === "number" ? fmt(v) : v}`)
          .join(" ");
        return `  ${sample?.code ?? "?"}${sample?.variationGroup ? ` (group ${sample.variationGroup})` : ""}: ${metrics}${r.note ? ` — ${r.note}` : ""}`;
      });
    if (rows.length) {
      L.push(`${c.name} — per-sample values:`);
      L.push(...rows);
    }
  }
  if (!stats.length && exp.characterizations.every((c) => !c.results.length))
    L.push("(no measurement results recorded)");

  return L.join("\n");
}

// The accuracy of this feature lives in this prompt — tune it here, not in
// the transport layer. Keep the hard rules (no outside data, no invented
// numbers, control-relative comparison) when editing.
function systemPrompt(lang: "en" | "zh"): string {
  return [
    "You are a meticulous research assistant for a perovskite solar-cell laboratory.",
    "You will receive the complete structured record of one experiment: its scientific framing, test plan, process steps, execution deviations, and measured results.",
    "Write an accurate analytical summary of what happened in this experiment.",
    "",
    "Hard rules:",
    "- Use ONLY the data in the record. Never invent, estimate, or recall numbers, materials, or steps that are not present. If something important is missing, say it was not recorded.",
    "- Quote numeric results exactly as given; the per-group aggregates are pre-computed for you — do not recompute or round differently.",
    "- Compare every test group against the control group and state the direction and size of the difference.",
    "- Treat flagged executions and deviations as caveats on the affected samples.",
    "- Be neutral: report what the data shows, including negative or inconclusive outcomes.",
    "",
    "Structure the summary as short paragraphs (no markdown headings) covering, in order:",
    "1. Purpose — what was varied and why, tied to the hypothesis.",
    "2. Method — the process route, key equipment, and how the groups differed.",
    "3. Results — the measured outcomes with exact numbers, best devices, and group-vs-control comparison.",
    "4. Data quality — deviations, flagged points, scrapped substrates, or missing measurements that qualify the results.",
    "5. Verdict — whether the data supports, contradicts, or cannot yet decide the hypothesis, with the reasoning.",
    "",
    lang === "zh"
      ? "Write the summary in Simplified Chinese. Keep sample codes, group labels, units and metric names (PCE, Voc, Jsc, FF) exactly as written."
      : "Write the summary in English. Keep sample codes, group labels, units and metric names exactly as written.",
  ].join("\n");
}

/**
 * Generate and persist the AI summary for an experiment. Returns null when no
 * AI provider is configured or the model call fails — the conclusion workflow
 * must keep working without it.
 */
export async function generateAiSummary(
  actor: Actor,
  rawId: unknown,
  lang: "en" | "zh",
): Promise<AiSummary | null> {
  const id = experimentIdSchema.parse(rawId);
  await assertEdit(actor, id);
  const exp = await getReportExperiment(actor, id);
  if (!exp) return null;

  const digest = buildDigest(exp);
  const reply = await chat(
    actor.org,
    [
      { role: "system", content: systemPrompt(lang) },
      { role: "user", content: digest },
    ],
    // Long analytical output; stays under the 60s Nginx proxy window.
    { maxTokens: 1800, temperature: 0, timeoutMs: 55_000 },
  );
  if (!reply?.trim()) return null;

  const summary: AiSummary = {
    text: reply.trim(),
    lang,
    model: (await activeProvider(actor.org))?.model ?? "unknown",
    generatedAt: new Date().toISOString(),
  };
  await db.$transaction(async (tx) => {
    const row = await tx.experiment.findUniqueOrThrow({
      where: { id },
      select: { metadata: true },
    });
    const metadata = {
      ...((row.metadata as Record<string, unknown> | null) ?? {}),
      aiSummary: summary,
    };
    await tx.experiment.update({
      where: { id },
      data: { metadata: metadata as Prisma.InputJsonValue },
    });
    await recordUserAudit(tx, {
      actor,
      action: "experiment.aiSummary",
      entityType: "Experiment",
      entityId: id,
      metadata: { lang, chars: summary.text.length },
    });
  });
  return summary;
}
