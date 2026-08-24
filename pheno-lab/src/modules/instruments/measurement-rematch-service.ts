import "server-only";

import { db } from "@/infrastructure/db/client";
import { recordSystemAudit } from "@/modules/audit/writer";
import { matchSerial, refreshSampleJvResult } from "./matching-service";

export type RematchSummary = {
  considered: number;
  matched: number;
  stillUnmatched: number;
  samplesUpdated: number;
};

/**
 * Retries measurements that could not be matched when they arrived.
 *
 * Scans routinely land before the experiment they belong to exists — a
 * technician measures in the morning and writes up the experiment after lunch —
 * so a single attempt at upload time is not enough. This sweep is run on a
 * schedule and by the "Pull J-V files" button on an experiment.
 *
 * `serialPrefixes` narrows the sweep to one experiment's serials — both its
 * full code ("2026-001-1-23") and its short handle ("E7"), since either may
 * have been typed on the instrument.
 */
export async function rematchMeasurements(opts: {
  organizationId: string;
  serialPrefixes?: string[];
  limit?: number;
}): Promise<RematchSummary> {
  const { organizationId, serialPrefixes, limit = 500 } = opts;
  const prefixes = (serialPrefixes ?? [])
    .filter(Boolean)
    .map((p) => p.toUpperCase());

  // Stranded rows (MATCHED but their sample was deleted by a test-plan edit)
  // are reset first, so they go through the normal matcher below.
  await db.$transaction(async (transaction) => {
    const stranded = await transaction.jvMeasurement.updateMany({
      where: { organizationId, status: "MATCHED", sampleId: null },
      data: {
        status: "UNMATCHED",
        matchNote: "Sample set changed — waiting to be re-matched.",
      },
    });
    if (stranded.count > 0) {
      await recordSystemAudit(transaction, {
        organizationId,
        action: "instrument.measurements.reset_for_rematch",
        entityType: "Organization",
        entityId: organizationId,
        metadata: { count: stranded.count },
      });
    }
  });

  const pending = await db.jvMeasurement.findMany({
    where: {
      organizationId,
      status: "UNMATCHED",
      ...(prefixes.length
        ? { OR: prefixes.map((p) => ({ serialKey: { startsWith: p } })) }
        : {}),
    },
    select: { id: true, serial: true },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  const touched = new Set<string>();
  let matched = 0;

  for (const m of pending) {
    const result = await matchSerial(organizationId, m.serial);
    if (result.status !== "MATCHED") {
      // Refresh the reason — the experiment may exist now but the sample not.
      await db.$transaction(async (transaction) => {
        await transaction.jvMeasurement.update({
          where: { id: m.id },
          data: { matchNote: result.matchNote },
        });
        await recordSystemAudit(transaction, {
          organizationId,
          action: "instrument.measurement.rematch_failed",
          entityType: "JvMeasurement",
          entityId: m.id,
          metadata: { reason: result.matchNote },
        });
      });
      continue;
    }
    await db.$transaction(async (transaction) => {
      await transaction.jvMeasurement.update({
        where: { id: m.id },
        data: {
          status: "MATCHED",
          experimentId: result.experimentId,
          sampleId: result.sampleId,
          runId: result.runId,
          matchNote: result.matchNote,
        },
      });
      await recordSystemAudit(transaction, {
        organizationId,
        action: "instrument.measurement.rematched",
        entityType: "JvMeasurement",
        entityId: m.id,
        changes: {
          experimentId: result.experimentId,
          sampleId: result.sampleId,
          runId: result.runId,
        },
      });
    });
    matched++;
    if (result.sampleId) touched.add(result.sampleId);
  }

  for (const sampleId of touched) await refreshSampleJvResult(sampleId);

  return {
    considered: pending.length,
    matched,
    stillUnmatched: pending.length - matched,
    samplesUpdated: touched.size,
  };
}

/** Sweeps every organization — used by the scheduled job. */
export async function rematchAllOrganizations(): Promise<
  Record<string, RematchSummary>
> {
  const orgs = await db.organization.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, slug: true },
  });
  const out: Record<string, RematchSummary> = {};
  for (const org of orgs) {
    out[org.slug] = await rematchMeasurements({ organizationId: org.id });
  }
  return out;
}
