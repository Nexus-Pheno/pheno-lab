/** Read-only aggregate inventory; never relabels samples or changes scan ownership. */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
async function main(): Promise<void> {
  try {
    const [inventory] = await db.$queryRaw<
      {
        experiments: number;
        samples: number;
        scans: number;
        duplicateCodes: number;
        stranded: number;
      }[]
    >`
    SELECT
      (SELECT count(*) FROM "Experiment")::int AS experiments,
      (SELECT count(*) FROM "Sample")::int AS samples,
      (SELECT count(*) FROM "JvMeasurement")::int AS scans,
      (SELECT count(*) FROM "JvMeasurement" WHERE status = 'MATCHED' AND "sampleId" IS NULL)::int AS stranded,
      (SELECT count(*) FROM (
        SELECT e."organizationId", s."simCode" FROM "Sample" s JOIN "Experiment" e ON e.id = s."experimentId"
        WHERE s."simCode" IS NOT NULL GROUP BY e."organizationId", s."simCode" HAVING count(*) > 1
      ) duplicates)::int AS "duplicateCodes"
  `;
    const reservations = await db.sampleCodeReservation.count();
    const ambiguousCodes = await db.sampleCodeReservation.count({
      where: { ambiguous: true },
    });
    console.log(
      JSON.stringify({
        checkedAt: new Date().toISOString(),
        ...inventory,
        reservations,
        ambiguousCodes,
      }),
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
