import "server-only";

import type { Prisma } from "@prisma/client";
import { db } from "@/infrastructure/db/client";
import type { Actor } from "@/modules/authorization/actor";
import { questionTerms } from "@/modules/insights/query";

// Which experiments a question is about. Retrieval is org-wide (the analysis
// scope, see query.ts) and driven by the question, not by recency: the old
// data-page ask read the 80 newest experiments and so answered "spin vs
// blade" from whichever recent batch happened to mention it.

const RETRIEVE = 120;
export const KEEP = 40;

export type Retrieval = {
  ids: string[];
  terms: string[];
  interpreted: boolean;
  /** Nothing matched the question; the newest measured experiments stand in. */
  fallback: boolean;
};

function analysisScope(actor: Actor): Prisma.ExperimentWhereInput {
  return { organizationId: actor.org, isTest: false, deletedAt: null };
}

export async function retrieveExperiments(
  actor: Actor,
  question: string,
): Promise<Retrieval> {
  const org = actor.org;
  const picked = await questionTerms(org, question);
  const ts = picked.terms;
  const base = analysisScope(actor);

  if (ts.length === 0)
    return {
      ids: await newestMeasured(base),
      terms: [],
      interpreted: false,
      fallback: true,
    };

  const contains = ts.map((t) => ({
    contains: t,
    mode: "insensitive" as const,
  }));
  const [materials, processes] = await Promise.all([
    db.material.findMany({
      where: { organizationId: org, OR: contains.map((c) => ({ name: c })) },
      select: { id: true },
      take: 40,
    }),
    db.process.findMany({
      where: { organizationId: org, OR: contains.map((c) => ({ name: c })) },
      select: { id: true },
      take: 20,
    }),
  ]);

  const or: Prisma.ExperimentWhereInput[] = ts.flatMap((t) => {
    const c = { contains: t, mode: "insensitive" as const };
    // A short term like "50" is a value, not a substring: "50" must not
    // pull in every "1500rpm".
    const valueMatch =
      t.length <= 3 ? { equals: t, mode: "insensitive" as const } : c;
    return [
      { title: c },
      { code: c },
      { campaign: c },
      { hypothesis: c },
      { conclusion: c },
      { observation: c },
      { createdBy: { name: c } },
      { steps: { some: { name: c } } },
      {
        steps: {
          some: {
            parameters: { some: { OR: [{ name: c }, { value: valueMatch }] } },
          },
        },
      },
      {
        steps: {
          some: {
            parameters: {
              some: { variations: { some: { value: valueMatch } } },
            },
          },
        },
      },
    ];
  });
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
  if (processes.length)
    or.push({
      steps: { some: { processId: { in: processes.map((p) => p.id) } } },
    });

  const rows = await db.experiment.findMany({
    where: { AND: [base, { OR: or }] },
    orderBy: { createdAt: "desc" },
    take: RETRIEVE,
    select: {
      id: true,
      title: true,
      campaign: true,
      hypothesis: true,
      conclusion: true,
      createdBy: { select: { name: true } },
      steps: {
        select: {
          name: true,
          process: { select: { name: true } },
          materials: { select: { material: { select: { name: true } } } },
          parameters: {
            select: {
              name: true,
              value: true,
              variations: { select: { value: true } },
            },
          },
        },
      },
      samples: {
        select: { results: { select: { id: true }, take: 1 } },
        take: 50,
      },
    },
  });
  if (rows.length === 0)
    return {
      ids: await newestMeasured(base),
      terms: ts,
      interpreted: picked.interpreted,
      fallback: true,
    };

  // Rank by how many of the question's terms an experiment answers to, then
  // prefer experiments with measured data — a recipe without results cannot
  // contribute a number.
  const lower = ts.map((t) => t.toLowerCase());
  const scored = rows.map((row) => {
    // What the experiment is ABOUT (title, campaign, creator) outranks a
    // term that merely appears somewhere in its recipe.
    const head = [row.title, row.campaign, row.createdBy.name]
      .join("\n")
      .toLowerCase();
    const body = [
      row.hypothesis,
      row.conclusion,
      ...row.steps.flatMap((s) => [
        s.process.name,
        s.name,
        ...s.materials.map((m) => m.material.name),
        ...s.parameters.flatMap((p) => [
          p.name,
          p.value,
          ...p.variations.map((v) => v.value),
        ]),
      ]),
    ]
      .join("\n")
      .toLowerCase();
    let score = 0;
    for (const t of lower) {
      if (head.includes(t)) score += 4;
      else if (body.includes(t)) score += 2;
    }
    if (row.samples.some((s) => s.results.length > 0)) score += 1;
    return { id: row.id, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return {
    ids: scored.slice(0, KEEP).map((s) => s.id),
    terms: ts,
    interpreted: picked.interpreted,
    fallback: false,
  };
}

async function newestMeasured(
  base: Prisma.ExperimentWhereInput,
): Promise<string[]> {
  const rows = await db.experiment.findMany({
    where: { AND: [base, { samples: { some: { results: { some: {} } } } }] },
    orderBy: { createdAt: "desc" },
    take: KEEP,
    select: { id: true },
  });
  return rows.map((r) => r.id);
}
