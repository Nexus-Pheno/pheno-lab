import "server-only";

import { db } from "@/infrastructure/db/client";

// The data-point total is what the lab shows first about itself: every
// (x, y) point of every stored measurement curve. It is kept as a running
// counter on the organization (bumped wherever scans are stored) and set
// straight here from the curves themselves, nightly, so drift never lasts
// more than a day.

export async function recountDataPoints(): Promise<
  { organizationId: string; dataPoints: number }[]
> {
  const rows = await db.$queryRaw<
    { organizationId: string; points: bigint | number | null }[]
  >`
    SELECT o."id" AS "organizationId",
           COALESCE(SUM(CASE WHEN jsonb_typeof(m."curve") = 'array'
                             THEN jsonb_array_length(m."curve") ELSE 0 END), 0) AS points
    FROM "Organization" o
    LEFT JOIN "JvMeasurement" m ON m."organizationId" = o."id"
    GROUP BY o."id"
  `;
  const out: { organizationId: string; dataPoints: number }[] = [];
  for (const row of rows) {
    const dataPoints = Number(row.points ?? 0);
    await db.organization.update({
      where: { id: row.organizationId },
      data: { dataPoints },
    });
    out.push({ organizationId: row.organizationId, dataPoints });
  }
  return out;
}
