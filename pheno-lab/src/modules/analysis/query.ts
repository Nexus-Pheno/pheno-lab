import "server-only";

import type { Prisma } from "@prisma/client";
import { db } from "@/infrastructure/db/client";
import type { Actor } from "@/modules/authorization/actor";
import {
  buildTidyRows,
  hasAnyMetric,
  variedConditions,
  type TidyRow,
  type VariedCondition,
} from "./dataset";
import { analysisScopeSchema, type AnalysisScope } from "./schema";

// Cross-experiment analysis is deliberately ORGANIZATION-WIDE for every role,
// technicians included (Michael, 2026-09-09): "there are not too many secrets
// kept org wide, we encourage sharing of results between teams". This widening
// applies to THIS surface only — aggregated conditions and metrics. Normal
// experiment visibility, contents, notes and attachments are unchanged, and a
// technician still cannot open an experiment they are not part of.
//
// Test experiments and trashed experiments stay out: the first is scratch
// space, the second is deleted as far as the lab is concerned.
function analysisScope(actor: Actor): Prisma.ExperimentWhereInput {
  return { organizationId: actor.org, isTest: false, deletedAt: null };
}

/** Rows are capped so one broad question cannot pull the whole database. */
const MAX_EXPERIMENTS = 400;

const datasetInclude = {
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
} satisfies Prisma.ExperimentInclude;

function whereFor(
  actor: Actor,
  scope: AnalysisScope,
): Prisma.ExperimentWhereInput {
  const and: Prisma.ExperimentWhereInput[] = [analysisScope(actor)];
  if (scope.projectId) and.push({ projectId: scope.projectId });
  // Beijing dates: the lab's own calendar day, shifted back to UTC bounds.
  if (scope.from)
    and.push({ createdAt: { gte: new Date(`${scope.from}T00:00:00+08:00`) } });
  if (scope.to)
    and.push({ createdAt: { lte: new Date(`${scope.to}T23:59:59+08:00`) } });
  if (scope.q) {
    const term = scope.q;
    and.push({
      OR: [
        { code: { contains: term, mode: "insensitive" } },
        { title: { contains: term, mode: "insensitive" } },
        { campaign: { contains: term, mode: "insensitive" } },
        { hypothesis: { contains: term, mode: "insensitive" } },
        { conclusion: { contains: term, mode: "insensitive" } },
        {
          steps: {
            some: {
              OR: [
                { process: { name: { contains: term, mode: "insensitive" } } },
                {
                  materials: {
                    some: {
                      material: {
                        name: { contains: term, mode: "insensitive" },
                      },
                    },
                  },
                },
              ],
            },
          },
        },
      ],
    });
  }
  return { AND: and };
}

export type AnalysisDataset = {
  rows: TidyRow[];
  /** Conditions that more than one experiment varied — the joinable ones. */
  conditions: (VariedCondition & { experiments: number; values: string[] })[];
  experiments: number;
  samplesWithData: number;
  truncated: boolean;
};

export async function loadAnalysisDataset(
  actor: Actor,
  rawScope: unknown,
): Promise<AnalysisDataset> {
  const scope = analysisScopeSchema.parse(rawScope);
  const experiments = await db.experiment.findMany({
    where: whereFor(actor, scope),
    orderBy: { createdAt: "desc" },
    take: MAX_EXPERIMENTS + 1,
    include: datasetInclude,
  });
  const truncated = experiments.length > MAX_EXPERIMENTS;
  const page = truncated ? experiments.slice(0, MAX_EXPERIMENTS) : experiments;

  const rows = buildTidyRows(page);
  const measured = rows.filter(hasAnyMetric);

  // A condition is only worth offering when the dataset can actually compare
  // it: at least two distinct values, carried by measured samples.
  const catalog = new Map<
    string,
    VariedCondition & { experiments: Set<string>; values: Set<string> }
  >();
  for (const exp of page) {
    for (const condition of variedConditions(exp)) {
      const known = catalog.get(condition.key) ?? {
        ...condition,
        experiments: new Set<string>(),
        values: new Set<string>(),
      };
      known.experiments.add(exp.id);
      catalog.set(condition.key, known);
    }
  }
  for (const row of measured) {
    for (const [key, value] of Object.entries(row.conditions)) {
      catalog.get(key)?.values.add(value);
    }
  }

  const conditions = [...catalog.values()]
    .filter((c) => c.values.size >= 2)
    .map((c) => ({
      key: c.key,
      label: c.label,
      unit: c.unit,
      process: c.process,
      byGroup: c.byGroup,
      experiments: c.experiments.size,
      values: [...c.values].sort(),
    }))
    // The conditions tried across the most experiments answer the most.
    .sort(
      (a, b) =>
        b.experiments - a.experiments ||
        b.values.length - a.values.length ||
        a.label.localeCompare(b.label),
    );

  return {
    rows: measured,
    conditions,
    experiments: page.length,
    samplesWithData: measured.length,
    truncated,
  };
}

/** The projects offered in the scope picker. */
export async function listAnalysisProjects(actor: Actor) {
  return db.project.findMany({
    where: { organizationId: actor.org },
    orderBy: [{ active: "desc" }, { name: "asc" }],
    select: { id: true, name: true },
  });
}
