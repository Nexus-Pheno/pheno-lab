import "server-only";
import { METRICS, type MetricKey } from "@/lib/analysis-metrics";

import type { Prisma } from "@prisma/client";
import { db } from "@/infrastructure/db/client";
import type { Actor } from "@/modules/authorization/actor";
import { experimentVisibilityScope } from "@/modules/authorization/scope";
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

/** Numbers arrive as numbers (instrument JSON) or strings (capture inputs). */
export const numish = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim()) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

// One definition, shared with the client components that render metrics.
export { METRICS, type MetricKey };

/** "PCE (%)" → pce, "Voc (V)" → voc — result rows label their metrics. */
export const metricKeyOf = (label: string): MetricKey | null => {
  if (/pce|efficiency|^eff/i.test(label)) return "pce";
  if (/voc/i.test(label)) return "voc";
  if (/jsc/i.test(label)) return "jsc";
  if (/^ff|fill/i.test(label)) return "ff";
  return null;
};

const fmt = (v: number) =>
  v
    .toPrecision(4)
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");

type GroupBuckets = Map<
  string,
  Record<MetricKey, { value: number; code: string }[]>
>;

/** JV metrics per variation group, with the sample each value came from. */
function collectGroupMetrics(exp: ReportExperiment): GroupBuckets {
  const byGroup: GroupBuckets = new Map();
  for (const c of exp.characterizations) {
    for (const r of c.results) {
      const sample = exp.samples.find((s) => s.id === r.sampleId);
      if (!sample?.variationGroup) continue;
      const metrics = (r.metrics ?? {}) as Record<string, unknown>;
      const bucket =
        byGroup.get(sample.variationGroup) ??
        byGroup
          .set(sample.variationGroup, { pce: [], voc: [], jsc: [], ff: [] })
          .get(sample.variationGroup)!;
      for (const [label, raw] of Object.entries(metrics)) {
        const key = metricKeyOf(label);
        const v = key ? numish(raw) : null;
        if (key && v !== null)
          bucket[key].push({ value: v, code: sample.code });
      }
    }
  }
  return byGroup;
}

/** Per-group aggregates of the JV metrics scientists actually compare. */
function groupStats(byGroup: GroupBuckets): string[] {
  const lines: string[] = [];
  for (const [group, buckets] of [...byGroup.entries()].sort()) {
    const parts: string[] = [];
    for (const m of METRICS) {
      const vals = buckets[m].map((x) => x.value);
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

export type DigestScan = {
  serial: string;
  metrics: unknown;
  sample: { code: string; variationGroup: string | null } | null;
};

/**
 * Deterministic anomaly flags, computed here so the model discusses them
 * instead of skating past: negative shunt/series resistances (measurement
 * artifacts the technicians track by hand today), within-group PCE outliers,
 * and the champion device.
 */
function anomalyFlags(byGroup: GroupBuckets, scans: DigestScan[]): string[] {
  const flags: string[] = [];

  // Champion device across the experiment.
  let champion: { code: string; group: string; value: number } | null = null;
  for (const [group, buckets] of byGroup.entries()) {
    for (const x of buckets.pce) {
      if (!champion || x.value > champion.value)
        champion = { code: x.code, group, value: x.value };
    }
  }
  if (champion)
    flags.push(
      `Champion device: sample ${champion.code} (group ${champion.group}) at PCE ${fmt(champion.value)}.`,
    );

  // Negative Rsh/Rs on raw scans — physically impossible, so a measurement
  // artifact; the efficiency numbers of the same scan are still usable.
  const seen = new Set<string>();
  for (const scan of scans) {
    const m = (scan.metrics ?? {}) as Record<string, unknown>;
    for (const key of ["rsh", "rs"] as const) {
      const v = num(m[key]);
      if (v === null || v >= 0) continue;
      const label = key === "rsh" ? "Rsh" : "Rs";
      const who = scan.sample
        ? `sample ${scan.sample.code}${scan.sample.variationGroup ? ` (group ${scan.sample.variationGroup})` : ""}`
        : `serial ${scan.serial}`;
      const flag = `${who}: ${label}=${fmt(v)} Ω is negative — measurement artifact (noise/contact), not a real device property; its PCE/Voc/Jsc/FF remain valid.`;
      if (!seen.has(flag)) {
        seen.add(flag);
        flags.push(flag);
      }
    }
  }

  // Within-group PCE outliers (n>=3, > 2 standard deviations from the mean).
  for (const [group, buckets] of [...byGroup.entries()].sort()) {
    const vals = buckets.pce;
    if (vals.length < 3) continue;
    const mean = vals.reduce((a, b) => a + b.value, 0) / vals.length;
    const std = Math.sqrt(
      vals.reduce((a, b) => a + (b.value - mean) ** 2, 0) / vals.length,
    );
    if (std === 0) continue;
    for (const x of vals) {
      if (Math.abs(x.value - mean) > 2 * std)
        flags.push(
          `Sample ${x.code} (group ${group}): PCE ${fmt(x.value)} is an outlier vs group mean ${fmt(mean)}.`,
        );
    }
  }

  return flags;
}

/** Everything the model is allowed to know, as compact labeled plain text. */
function buildDigest(exp: ReportExperiment, scans: DigestScan[] = []): string {
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
  const byGroup = collectGroupMetrics(exp);
  const stats = groupStats(byGroup);
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

  section("Pre-computed anomaly flags");
  const flags = anomalyFlags(byGroup, scans);
  if (flags.length) L.push(...flags);
  else L.push("(none detected)");

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
    "3. Results — the measured outcomes with exact numbers, the champion device (sample code, group and PCE, as pre-computed), and group-vs-control comparison.",
    "4. Data quality — deviations, flagged points, scrapped substrates, or missing measurements that qualify the results. Address every pre-computed anomaly flag: name the affected samples, and repeat the flag's own explanation (e.g. a negative Rsh is a measurement artifact whose efficiency values remain valid) rather than inventing your own.",
    "5. Verdict — whether the data supports, contradicts, or cannot yet decide the hypothesis, with the reasoning.",
    "6. Recommendations — what this result means for the team and what to do next: the most informative follow-up experiment, which process conditions or materials look worth pushing further, and what to fix in how data was recorded (e.g. missing measurements or unrecorded equipment). Ground every suggestion in the record above — no generic advice that would apply to any experiment.",
    "",
    lang === "zh"
      ? "Write the summary in Simplified Chinese, at most about 1000 characters. Keep sample codes, group labels, units and metric names (PCE, Voc, Jsc, FF) exactly as written."
      : "Write the summary in English, at most about 600 words. Keep sample codes, group labels, units and metric names exactly as written.",
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

  // Raw scans carry Rsh/Rs, which the result rows do not — fetched only for
  // the deterministic anomaly flags.
  const scans: DigestScan[] = await db.jvMeasurement.findMany({
    where: { experimentId: id, status: "MATCHED" },
    select: {
      serial: true,
      metrics: true,
      sample: { select: { code: true, variationGroup: true } },
    },
  });

  const digest = buildDigest(exp, scans);
  const reply = await chat(
    actor.org,
    [
      { role: "system", content: systemPrompt(lang) },
      { role: "user", content: digest },
    ],
    // Reasoning models (deepseek-v4-flash) spend max_tokens on hidden
    // reasoning BEFORE the visible answer — 1800 got fully eaten by thinking
    // and returned an empty content. The prompt bounds the visible length;
    // the timeout stays under the 60s Nginx proxy window.
    { maxTokens: 5000, temperature: 0, timeoutMs: 55_000 },
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

// ---- background generation -------------------------------------------------
//
// Generation takes ~30s, so the browser must not have to keep the request
// alive: startAiSummary records a "running" marker in metadata, kicks the
// generation off detached (same fire-and-forget pattern as translations),
// and the client polls getAiSummaryState — leaving the page and coming back
// resumes the spinner from the persisted marker.

export type AiSummaryRun = {
  state: "running" | "done" | "failed";
  startedAt: string;
  lang: "en" | "zh";
};

/** A "running" marker older than this is a crashed run — allow a restart. */
export const AI_SUMMARY_STALE_MS = 3 * 60_000;

async function writeRunState(id: string, patch: AiSummaryRun) {
  const row = await db.experiment.findUniqueOrThrow({
    where: { id },
    select: { metadata: true },
  });
  const metadata = {
    ...((row.metadata as Record<string, unknown> | null) ?? {}),
    aiSummaryRun: patch,
  };
  await db.experiment.update({
    where: { id },
    data: { metadata: metadata as Prisma.InputJsonValue },
  });
}

export async function startAiSummary(
  actor: Actor,
  rawId: unknown,
  lang: "en" | "zh",
): Promise<AiSummaryRun> {
  const id = experimentIdSchema.parse(rawId);
  await assertEdit(actor, id);
  const row = await db.experiment.findUniqueOrThrow({
    where: { id },
    select: { metadata: true },
  });
  const existing = (row.metadata as { aiSummaryRun?: AiSummaryRun } | null)
    ?.aiSummaryRun;
  if (
    existing?.state === "running" &&
    Date.now() - Date.parse(existing.startedAt) < AI_SUMMARY_STALE_MS
  ) {
    return existing; // one generation at a time
  }
  const run: AiSummaryRun = {
    state: "running",
    startedAt: new Date().toISOString(),
    lang,
  };
  await writeRunState(id, run);
  void generateAiSummary(actor, id, lang)
    .then((summary) =>
      writeRunState(id, { ...run, state: summary ? "done" : "failed" }),
    )
    .catch(() =>
      writeRunState(id, { ...run, state: "failed" }).catch(() => {}),
    );
  return run;
}

/** Poll target for the client; read access follows experiment visibility. */
export async function getAiSummaryState(
  actor: Actor,
  rawId: unknown,
): Promise<{ run: AiSummaryRun | null; summary: AiSummary | null } | null> {
  const id = experimentIdSchema.parse(rawId);
  const row = await db.experiment.findFirst({
    where: { AND: [{ id }, experimentVisibilityScope(actor, true)] },
    select: { metadata: true },
  });
  if (!row) return null;
  const meta = row.metadata as {
    aiSummaryRun?: AiSummaryRun;
    aiSummary?: AiSummary;
  } | null;
  return { run: meta?.aiSummaryRun ?? null, summary: meta?.aiSummary ?? null };
}
