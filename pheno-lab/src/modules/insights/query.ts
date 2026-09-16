import "server-only";

import type { Prisma } from "@prisma/client";
import { db } from "@/infrastructure/db/client";
import { nameKey } from "@/lib/name-match";
import { chat, jsonFrom } from "@/modules/ai/client";
import { latinPhrases, mergeTerms, terms } from "./terms";
import type { Actor } from "@/modules/authorization/actor";
import { experimentVisibilityScope } from "@/modules/authorization/scope";

// Read-only views over the database: how much is in it, and finding the
// experiments related to a material, a process, a formula or a question.

export type DatabaseSummary = {
  experiments: number;
  samples: number;
  runs: number;
  steps: number;
  characterizations: number;
  results: number;
  attachments: number;
  materials: number;
  recipes: number;
  equipment: number;
  processes: number;
  /** Individual recorded values — see countDataPoints for what counts. */
  dataPoints: number;
  testExperiments: number;
};

function jsonKeys(v: unknown): number {
  if (!v || typeof v !== "object") return 0;
  if (Array.isArray(v)) return v.length;
  return Object.keys(v as Record<string, unknown>).length;
}

/**
 * How many individual data points the database holds.
 *
 * A data point is one recorded value — the row × column intersection the lab
 * thinks in. Counted:
 *   - every planned step parameter          (one name/value pair)
 *   - every metric on a characterisation    (PCE, Voc, FF … each counts)
 *   - every actual captured against a step  (plus its environment readings)
 *   - every property on a material          (CAS, HOMO, supplier …)
 * Samples, experiments and files are counted separately, as their own totals.
 */
async function countDataPoints(
  orgId: string,
  experimentWhere: Prisma.ExperimentWhereInput,
): Promise<number> {
  const [params, results, execs, materials] = await Promise.all([
    db.stepParameter.count({
      where: { step: { experiment: experimentWhere } },
    }),
    db.characterizationResult.findMany({
      where: { characterization: { experiment: experimentWhere } },
      select: { metrics: true },
    }),
    db.stepExecution.findMany({
      where: { step: { experiment: experimentWhere } },
      select: { actuals: true, environmentConditions: true },
    }),
    db.material.findMany({
      where: { organizationId: orgId, archived: false },
      select: { properties: true },
    }),
  ]);

  let n = params;
  for (const r of results) n += jsonKeys(r.metrics);
  for (const e of execs)
    n += jsonKeys(e.actuals) + jsonKeys(e.environmentConditions);
  for (const m of materials) n += jsonKeys(m.properties);
  return n;
}

export async function getDatabaseSummary(
  actor: Actor,
  includeTest = false,
): Promise<DatabaseSummary> {
  const org = actor.org;
  const where = experimentVisibilityScope(actor, includeTest);
  const visibleTestWhere: Prisma.ExperimentWhereInput = {
    AND: [experimentVisibilityScope(actor, true), { isTest: true }],
  };

  const [
    experiments,
    samples,
    runs,
    steps,
    characterizations,
    results,
    attachments,
    materials,
    recipes,
    equipment,
    processes,
    testExperiments,
    dataPoints,
  ] = await Promise.all([
    db.experiment.count({ where }),
    db.sample.count({ where: { experiment: where } }),
    db.run.count({ where: { experiment: where } }),
    db.processStep.count({ where: { experiment: where } }),
    db.characterization.count({ where: { experiment: where } }),
    db.characterizationResult.count({
      where: { characterization: { experiment: where } },
    }),
    db.attachment.count({
      where: {
        OR: [
          {
            characterizationResult: {
              characterization: { experiment: where },
            },
          },
          { stepExecution: { step: { experiment: where } } },
        ],
      },
    }),
    db.material.count({ where: { organizationId: org, archived: false } }),
    db.recipe.count({ where: { organizationId: org, archived: false } }),
    db.equipment.count({ where: { organizationId: org, archived: false } }),
    db.process.count({ where: { organizationId: org, archived: false } }),
    db.experiment.count({ where: visibleTestWhere }),
    countDataPoints(org, where),
  ]);

  return {
    experiments,
    samples,
    runs,
    steps,
    characterizations,
    results,
    attachments,
    materials,
    recipes,
    equipment,
    processes,
    dataPoints,
    testExperiments,
  };
}

// ---------------------------------------------------------------- search

export type SearchHit = {
  id: string;
  code: string;
  title: string;
  status: string;
  isTest: boolean;
  createdBy: string;
  samples: number;
  /** Why this experiment matched, e.g. "material: PbI2 (lead iodide)". */
  reasons: string[];
};

export type SearchResponse = {
  hits: SearchHit[];
  /** What the query was understood to mean, shown back to the user. */
  interpreted: string;
  terms: string[];
};

/** Split a question into searchable terms, dropping filler words. */
/**
 * Reduce a question in plain language ("which experiments used Cell-17 on
 * FTO?") to the names worth searching for. The model only ever picks search
 * terms — it never decides what matches, so a wrong or missing model degrades
 * this to keyword search rather than returning wrong science. Shared with
 * the cross-experiment analysis, which retrieves on the same terms.
 */
export async function questionTerms(
  org: string,
  q: string,
): Promise<{ terms: string[]; interpreted: boolean }> {
  // Names written in Latin letters (customers, products, materials) are
  // kept whatever the model decides — "First solar" glued into a Chinese
  // sentence was lost entirely before (实验系统反馈 2026-09-16 §四).
  const must = latinPhrases(q);
  let ts = mergeTerms(terms(q), must);
  let interpreted = false;
  // Chinese questions rarely contain whitespace; a long enough string is a
  // sentence whichever script it is written in.
  const wordy =
    (/\s/.test(q.trim()) && q.trim().split(/\s+/).length >= 4) ||
    q.trim().length >= 12;
  if (wordy) {
    const [mats, procs, recs, params] = await Promise.all([
      db.material.findMany({
        where: { organizationId: org, archived: false },
        select: { name: true },
        take: 400,
      }),
      db.process.findMany({
        where: { organizationId: org, archived: false },
        select: { name: true },
      }),
      db.recipe.findMany({
        where: { organizationId: org, archived: false },
        select: { name: true },
      }),
      // The parameter vocabulary, so "50 尺寸基底" can become the term the
      // data actually carries ("50" under 基底尺寸) instead of nothing.
      db.stepParameter.groupBy({
        by: ["name", "value"],
        where: {
          step: { experiment: { organizationId: org } },
          value: { not: "" },
        },
        _count: { _all: true },
        orderBy: { _count: { value: "desc" } },
        take: 600,
      }),
    ]);
    const vocab = new Map<string, string[]>();
    for (const row of params) {
      if (row.value.length > 24) continue;
      const list = vocab.get(row.name) ?? [];
      if (list.length < 8) list.push(row.value);
      vocab.set(row.name, list);
    }
    const paramLines = [...vocab.entries()]
      .slice(0, 40)
      .map(([name, values]) => `${name}: ${values.join(" | ")}`)
      .join("\n");
    const reply = await chat(
      org,
      [
        {
          role: "system",
          content:
            "You turn a lab question into search terms. Reply ONLY with JSON: " +
            '{"terms":["..."]}. Pick terms from the provided lists where they match — ' +
            "material, process and formula names, and for parameters the VALUE as written " +
            '(a question about "50尺寸基底" becomes the 基底尺寸 value "50"). ' +
            "Otherwise use the user's own words. Maximum 6 terms. Never invent names.",
        },
        {
          role: "user",
          content:
            `Question: ${q}\n\nMaterials: ${mats
              .map((m) => m.name)
              .slice(0, 400)
              .join(", ")}` +
            `\n\nProcesses: ${procs.map((p) => p.name).join(", ")}` +
            `\n\nFormulas: ${recs.map((r) => r.name).join(", ")}` +
            `\n\nParameters (name: values):\n${paramLines}`,
        },
      ],
      { maxTokens: 200 },
    );
    const parsed = jsonFrom(reply);
    const picked = Array.isArray(parsed?.terms)
      ? (parsed!.terms as unknown[])
      : [];
    const clean = picked
      .map((x) => String(x).trim())
      .filter((x) => x.length > 1)
      .slice(0, 6);
    if (clean.length) {
      ts = mergeTerms(clean, must);
      interpreted = true;
    }
  }
  return { terms: ts, interpreted };
}

export async function searchExperiments(
  actor: Actor,
  query: string,
  includeTest = false,
): Promise<SearchResponse> {
  const org = actor.org;
  const where = experimentVisibilityScope(actor, includeTest);
  const q = (query ?? "").trim();
  if (!q) return { hits: [], interpreted: "", terms: [] };
  const picked = await questionTerms(org, q);
  const ts = picked.terms;
  const aiNote = picked.interpreted
    ? " (interpreted by the configured model)"
    : "";

  if (ts.length === 0) return { hits: [], interpreted: q, terms: [] };

  const contains = ts.map((t) => ({
    contains: t,
    mode: "insensitive" as const,
  }));

  // Resolve names first so a hit can say *why* it matched.
  const [materials, processes, recipes] = await Promise.all([
    db.material.findMany({
      where: { organizationId: org, OR: contains.map((c) => ({ name: c })) },
      select: { id: true, name: true },
      take: 40,
    }),
    db.process.findMany({
      where: { organizationId: org, OR: contains.map((c) => ({ name: c })) },
      select: { id: true, name: true },
      take: 20,
    }),
    db.recipe.findMany({
      where: { organizationId: org, OR: contains.map((c) => ({ name: c })) },
      select: { id: true, name: true },
      take: 20,
    }),
  ]);

  const textOr = ts.flatMap((t) => [
    { title: { contains: t, mode: "insensitive" as const } },
    { code: { contains: t, mode: "insensitive" as const } },
    { campaign: { contains: t, mode: "insensitive" as const } },
    { hypothesis: { contains: t, mode: "insensitive" as const } },
    { problem: { contains: t, mode: "insensitive" as const } },
    { conclusion: { contains: t, mode: "insensitive" as const } },
    { observation: { contains: t, mode: "insensitive" as const } },
    { createdBy: { name: { contains: t, mode: "insensitive" as const } } },
    {
      samples: {
        some: { code: { contains: t, mode: "insensitive" as const } },
      },
    },
  ]);

  const or: Record<string, unknown>[] = [...textOr];
  if (materials.length)
    or.push({
      steps: {
        some: {
          materials: {
            some: { materialId: { in: materials.map((m) => m.id) } },
          },
        },
      },
    });
  if (processes.length) {
    or.push({
      steps: { some: { processId: { in: processes.map((p) => p.id) } } },
    });
    or.push({
      characterizations: {
        some: { processId: { in: processes.map((p) => p.id) } },
      },
    });
  }
  if (recipes.length)
    or.push({
      steps: { some: { recipeId: { in: recipes.map((r) => r.id) } } },
    });

  const rows = await db.experiment.findMany({
    where: { AND: [where, { OR: or }] },
    orderBy: { updatedAt: "desc" },
    take: 60,
    select: {
      id: true,
      code: true,
      title: true,
      status: true,
      isTest: true,
      campaign: true,
      hypothesis: true,
      conclusion: true,
      createdBy: { select: { name: true } },
      _count: { select: { samples: true } },
      steps: {
        select: {
          process: { select: { name: true } },
          recipe: { select: { name: true } },
          materials: { select: { material: { select: { name: true } } } },
        },
      },
    },
  });

  const matIds = new Set(materials.map((m) => nameKey(m.name)));
  const procIds = new Set(processes.map((p) => nameKey(p.name)));
  const recIds = new Set(recipes.map((r) => nameKey(r.name)));

  const hits: SearchHit[] = rows.map((r) => {
    const reasons: string[] = [];
    const seen = new Set<string>();
    for (const s of r.steps) {
      for (const m of s.materials) {
        if (
          matIds.has(nameKey(m.material.name)) &&
          !seen.has("m" + m.material.name)
        ) {
          seen.add("m" + m.material.name);
          reasons.push(`material: ${m.material.name}`);
        }
      }
      if (
        s.process &&
        procIds.has(nameKey(s.process.name)) &&
        !seen.has("p" + s.process.name)
      ) {
        seen.add("p" + s.process.name);
        reasons.push(`process: ${s.process.name}`);
      }
      if (
        s.recipe &&
        recIds.has(nameKey(s.recipe.name)) &&
        !seen.has("r" + s.recipe.name)
      ) {
        seen.add("r" + s.recipe.name);
        reasons.push(`formula: ${s.recipe.name}`);
      }
    }
    const hay =
      `${r.title} ${r.code} ${r.campaign} ${r.hypothesis} ${r.conclusion}`.toLowerCase();
    for (const t of ts)
      if (hay.includes(t.toLowerCase())) reasons.push(`text: “${t}”`);
    return {
      id: r.id,
      code: r.code,
      title: r.title,
      status: r.status,
      isTest: r.isTest,
      createdBy: r.createdBy?.name ?? "",
      samples: r._count.samples,
      reasons: [...new Set(reasons)].slice(0, 4),
    };
  });

  // Most explained matches first — an experiment matching a material AND a
  // process is a better answer than one matching a word in its title.
  hits.sort((a, b) => b.reasons.length - a.reasons.length);

  const named = [
    ...materials.map((m) => `material ${m.name}`),
    ...processes.map((p) => `process ${p.name}`),
    ...recipes.map((r) => `formula ${r.name}`),
  ];
  const interpreted =
    (named.length
      ? `Searching for ${named.slice(0, 4).join(", ")}${named.length > 4 ? "…" : ""}`
      : `Searching text for ${ts.map((t) => `“${t}”`).join(", ")}`) + aiNote;

  return { hits, interpreted, terms: ts };
}
