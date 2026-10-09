import "server-only";

import type { Prisma } from "@prisma/client";
import { db } from "@/infrastructure/db/client";
import type { Actor } from "@/modules/authorization/actor";
import { experimentVisibilityScope } from "@/modules/authorization/scope";
import { isJvTesting, testingSearchSchema } from "./schema";

/** Fresh database restriction checks; a testing grant never expands general experiment scope. */
export async function testingExperimentScope(
  actor: Actor,
): Promise<Prisma.ExperimentWhereInput> {
  const user = await db.user.findFirstOrThrow({
    where: {
      id: actor.uid,
      organizationId: actor.org,
      active: true,
      pendingApproval: false,
      mustChangePassword: false,
    },
    select: { role: true, testingOnly: true },
  });
  return user.testingOnly
    ? { organizationId: actor.org, deletedAt: null, isTest: false }
    : experimentVisibilityScope({
        ...actor,
        role: user.role,
        testingOnly: false,
        mustChangePassword: false,
      });
}

const jvStage: Prisma.CharacterizationWhereInput = {
  OR: [
    "jv",
    "j-v",
    "j v",
    "j−v",
    "j–v",
    "solar",
    "太阳",
    "伏安",
    "电流",
  ].flatMap((term) => [
    { name: { contains: term, mode: "insensitive" as const } },
    { process: { name: { contains: term, mode: "insensitive" as const } } },
  ]),
};

const samplesSelect = { id: true, code: true, simCode: true } as const;
// Instrument metrics are extensible JSON; expose only recognized JV numbers.
function testingMetrics(value: Prisma.JsonValue) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    [
      "voc",
      "isc",
      "jsc",
      "pmax",
      "vmax",
      "imax",
      "pce",
      "ff",
      "rs",
      "rsh",
      "area",
    ]
      .filter(
        (key) => typeof value[key] === "number" && Number.isFinite(value[key]),
      )
      .map((key) => [key, value[key]]),
  );
}
const requestSelect = {
  id: true,
  sampleIds: true,
  note: true,
  createdAt: true,
  run: { select: { runNo: true } },
} as const;

export async function listTestingExperiments(actor: Actor, raw: unknown) {
  const input = testingSearchSchema.parse(raw);
  const scope = await testingExperimentScope(actor);
  const where: Prisma.ExperimentWhereInput = {
    AND: [
      scope,
      {
        OR: [
          { characterizations: { some: jvStage } },
          {
            jvMeasurements: {
              some: { organizationId: actor.org, status: { not: "IGNORED" } },
            },
          },
          { testingRequests: { some: { organizationId: actor.org } } },
        ],
      },
      ...(input.q
        ? [
            {
              OR: [
                { code: { contains: input.q, mode: "insensitive" as const } },
                {
                  samples: {
                    some: {
                      OR: [
                        {
                          code: {
                            contains: input.q,
                            mode: "insensitive" as const,
                          },
                        },
                        {
                          simCode: {
                            contains: input.q,
                            mode: "insensitive" as const,
                          },
                        },
                      ],
                    },
                  },
                },
              ],
            },
          ]
        : []),
    ],
  };
  const scanWhere = { organizationId: actor.org, status: { not: "IGNORED" } };
  const [total, rows, recentRequests] = await Promise.all([
    db.experiment.count({ where }),
    db.experiment.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 25,
      skip: (input.page - 1) * 25,
      select: {
        id: true,
        code: true,
        samples: { select: samplesSelect },
        _count: {
          select: {
            jvMeasurements: { where: scanWhere },
            testingRequests: { where: { organizationId: actor.org } },
          },
        },
        jvMeasurements: {
          where: scanWhere,
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { createdAt: true },
        },
      },
    }),
    db.testingRequest.findMany({
      where: { organizationId: actor.org, experiment: scope },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        createdAt: true,
        sampleIds: true,
        experiment: {
          select: { id: true, code: true, samples: { select: samplesSelect } },
        },
      },
    }),
  ]);
  return {
    total,
    page: input.page,
    q: input.q,
    recentRequests: recentRequests.map((r) => ({
      id: r.id,
      experimentId: r.experiment.id,
      code: r.experiment.code,
      createdAt: r.createdAt.toISOString(),
      samples: r.experiment.samples.filter((s) => r.sampleIds.includes(s.id)),
    })),
    rows: rows.map((row) => ({
      id: row.id,
      code: row.code,
      samples: row.samples,
      measurements: row._count.jvMeasurements,
      requests: row._count.testingRequests,
      updatedAt: row.jvMeasurements[0]?.createdAt.toISOString() ?? null,
    })),
  };
}

export async function getTestingExperiment(actor: Actor, id: string) {
  const scope = await testingExperimentScope(actor);
  const row = await db.experiment.findFirst({
    where: { AND: [scope, { id }] },
    select: {
      id: true,
      code: true,
      samples: { select: samplesSelect, orderBy: { code: "asc" } },
      characterizations: {
        select: {
          id: true,
          name: true,
          notes: true,
          settings: true,
          process: { select: { name: true } },
        },
        orderBy: { position: "asc" },
      },
      testingRequests: {
        where: { organizationId: actor.org },
        select: requestSelect,
        orderBy: { createdAt: "desc" },
        take: 50,
      },
      jvMeasurements: {
        where: { organizationId: actor.org, status: { not: "IGNORED" } },
        select: {
          id: true,
          serial: true,
          direction: true,
          condition: true,
          metrics: true,
          measuredAt: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
        take: 100,
      },
      _count: {
        select: {
          jvMeasurements: {
            where: { organizationId: actor.org, status: { not: "IGNORED" } },
          },
        },
      },
    },
  });
  if (!row) return null;
  const stages = row.characterizations
    .filter((c) => isJvTesting(c.name, c.process.name))
    .map((c) => ({
      id: c.id,
      name: c.name,
      notes: c.notes,
      settings: c.settings,
    }));
  if (
    !stages.length &&
    !row.jvMeasurements.length &&
    !row.testingRequests.length
  )
    return null;
  return {
    id: row.id,
    code: row.code,
    samples: row.samples,
    stages,
    requests: row.testingRequests.map((r) => ({
      id: r.id,
      note: r.note,
      createdAt: r.createdAt.toISOString(),
      runNo: r.run.runNo,
      samples: row.samples.filter((s) => r.sampleIds.includes(s.id)),
    })),
    measurements: row.jvMeasurements.map((m) => ({
      ...m,
      metrics: testingMetrics(m.metrics),
      measuredAt: m.measuredAt?.toISOString() ?? null,
      createdAt: m.createdAt.toISOString(),
    })),
    measurementCount: row._count.jvMeasurements,
  };
}
