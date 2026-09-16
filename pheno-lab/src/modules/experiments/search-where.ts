import type { Prisma } from "@prisma/client";

/**
 * Everything a person might name when looking for an experiment, as one
 * Prisma clause. Shared by the data table and the experiment search so "Rose"
 * finds Rose's experiments in both places, whichever box it was typed into
 * (Michael, 2026-09-16: one search that finds everything).
 */
export function experimentTermWhere(term: string): Prisma.ExperimentWhereInput {
  const c = { contains: term, mode: "insensitive" as const };
  return {
    OR: [
      { code: c },
      { title: c },
      { campaign: c },
      { hypothesis: c },
      { problem: c },
      { conclusion: c },
      { observation: c },
      { createdBy: { name: c } },
      { assignee: { name: c } },
      { members: { some: { user: { name: c } } } },
      { project: { name: c } },
      { labels: { some: { label: { name: c } } } },
      { samples: { some: { code: c } } },
      { jvMeasurements: { some: { operator: c } } },
      {
        steps: {
          some: {
            OR: [
              { name: c },
              { process: { name: c } },
              { materials: { some: { material: { name: c } } } },
              { recipe: { name: c } },
              { parameters: { some: { OR: [{ name: c }, { value: c }] } } },
            ],
          },
        },
      },
      { characterizations: { some: { process: { name: c } } } },
    ],
  };
}
