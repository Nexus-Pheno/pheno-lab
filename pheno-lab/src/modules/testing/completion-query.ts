import "server-only";

import type { Prisma } from "@prisma/client";
import { testingCompletion } from "./completion";
import { isJvTesting } from "./schema";

/** Returns status only; capture metrics never enter the read-only testing DTO. */
export async function getTestingCompletions(
  client: Prisma.TransactionClient,
  organizationId: string,
  experimentIds: string[],
): Promise<Map<string, ReturnType<typeof testingCompletion>>> {
  if (!experimentIds.length) return new Map();
  const rows = await client.experiment.findMany({
    where: {
      id: { in: experimentIds },
      organizationId,
      deletedAt: null,
      isTest: false,
    },
    select: {
      id: true,
      samples: { select: { id: true, variationGroup: true } },
      testingRequests: {
        where: { organizationId },
        select: {
          id: true,
          runId: true,
          characterizationId: true,
          run: { select: { status: true, experimentId: true } },
          characterization: {
            select: {
              experimentId: true,
              name: true,
              process: { select: { name: true } },
            },
          },
        },
      },
      characterizations: {
        where: { testingRequests: { some: { organizationId } } },
        select: {
          results: {
            select: {
              characterizationId: true,
              sampleId: true,
              runId: true,
              metrics: true,
              source: true,
              sourceMeasurementId: true,
            },
          },
        },
      },
      jvMeasurements: {
        where: { organizationId, status: "MATCHED" },
        select: { id: true, sampleId: true, runId: true },
      },
    },
  });
  return new Map(
    rows.map((row) => [
      row.id,
      testingCompletion({
        samples: row.samples,
        requests: row.testingRequests.map((request) => ({
          ...request,
          valid:
            request.run.status !== "CANCELLED" &&
            request.run.experimentId === row.id &&
            request.characterization.experimentId === row.id &&
            isJvTesting(
              request.characterization.name,
              request.characterization.process.name,
            ),
        })),
        results: row.characterizations.flatMap((card) => card.results),
        measurements: row.jvMeasurements,
      }),
    ]),
  );
}
