import "server-only";

import { db } from "@/infrastructure/db/client";
import { refreshSampleJvResult } from "./matching-service";
export { ensureShortCode, syncSampleSerials } from "./sample-serial-engine";
import { syncSampleSerials } from "./sample-serial-engine";

/**
 * Re-attaches measurements to an experiment's samples after the sample set was
 * rebuilt.
 *
 * Deleting samples sets JvMeasurement.sampleId to NULL but leaves the row
 * MATCHED, which would strand it: invisible on the sample AND absent from the
 * unmatched queue. Anything stranded is reset so the normal matcher can pick it
 * up again — by serial, so it lands on the same sample as before.
 */
export async function healOrphanedMeasurements(
  experimentId: string,
): Promise<number> {
  const stranded = await db.jvMeasurement.updateMany({
    where: {
      OR: [{ experimentId }, { experimentId: null }],
      sampleId: null,
      status: "MATCHED",
    },
    data: {
      status: "UNMATCHED",
      matchNote: "Sample set changed — waiting to be re-matched.",
    },
  });
  return stranded.count;
}

/** Convenience for the places that rebuild samples outside a transaction. */
export async function refreshExperimentSerials(
  experimentId: string,
): Promise<void> {
  await syncSampleSerials(db, experimentId);
  await healOrphanedMeasurements(experimentId);
  const samples = await db.sample.findMany({
    where: { experimentId },
    select: { id: true },
  });
  for (const s of samples) await refreshSampleJvResult(s.id);
}
