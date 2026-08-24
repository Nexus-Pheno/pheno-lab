import "server-only";

import type { Prisma } from "@prisma/client";
import { db } from "@/infrastructure/db/client";
import { nameKey } from "@/lib/name-match";
import { chat, jsonFrom } from "@/modules/ai/client";
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
const STOP = new Set([
  "the",
  "a",
  "an",
  "of",
  "in",
  "on",
  "for",
  "with",
  "and",
  "or",
  "to",
  "is",
  "are",
  "what",
  "which",
  "show",
  "me",
  "all",
  "any",
  "find",
  "experiments",
  "experiment",
  "that",
  "used",
  "use",
  "using",
  "was",
  "were",
  "did",
  "do",
  "have",
  "has",
  "how",
  "best",
  "highest",
  "most",
  "was",
  "从",
  "的",
  "了",
  "和",
  "与",
  "哪些",
  "实验",
]);

function terms(q: string): string[] {
  return [
    ...new Set(
      q
        .split(/[\s,;、，。?？!！"'()]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 1 && !STOP.has(s.toLowerCase())),
    ),
  ].slice(0, 8);
}

/**
 * Find experiments related to a query.
 *
 * Deliberately searches the things a scientist would name — a material, a
 * process, a formula, an operator, a sample code — not just the title text,
 * and reports which of those matched so a result is never unexplained.
 */
export async function searchExperiments(
  actor: Actor,
  query: string,
  includeTest = false,
): Promise<SearchResponse> {
  const org = actor.org;
  const where = experimentVisibilityScope(actor, includeTest);
  const q = (query ?? "").trim();
  if (!q) return { hits: [], interpreted: "", terms: [] };
  let ts = terms(q);
  let aiNote = "";

  // A question in plain language ("which experiments used Cell-17 on FTO?")
  // is reduced to the names worth searching for. The model only ever picks
  // search terms — it never decides what matches, so a wrong or missing model
  // degrades this to keyword search rather than returning wrong science.
  if (/\s/.test(q.trim()) && q.trim().split(/\s+/).length >= 4) {
    const [mats, procs, recs] = await Promise.all([
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
    ]);
    const reply = await chat(
      org,
      [
        {
          role: "system",
          content:
            "You turn a lab question into search terms. Reply ONLY with JSON: " +
            '{"terms":["..."]}. Pick terms from the provided lists where they match, ' +
            "otherwise use the user's own words. Maximum 6 terms. Never invent material names.",
        },
        {
          role: "user",
          content:
            `Question: ${q}\n\nMaterials: ${mats
              .map((m) => m.name)
              .slice(0, 400)
              .join(", ")}` +
            `\n\nProcesses: ${procs.map((p) => p.name).join(", ")}` +
            `\n\nFormulas: ${recs.map((r) => r.name).join(", ")}`,
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
      ts = clean;
      aiNote = " (interpreted by the configured model)";
    }
  }

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
