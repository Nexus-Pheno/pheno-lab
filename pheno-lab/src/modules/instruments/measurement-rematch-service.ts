import "server-only";

import { db } from "@/infrastructure/db/client";
import { recordSystemAudit } from "@/modules/audit/writer";
import { matchSerial, refreshSampleJvResult } from "./matching-service";
import { matchOperatorToUser } from "./operator-match";

export type RematchSummary = {
  considered: number;
  matched: number;
  stillUnmatched: number;
  samplesUpdated: number;
  /** Scans no sample explained, handed to the operator who ran them. */
  assignedByOperator: number;
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
    select: { id: true, serial: true, operator: true, assignedToId: true },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  // Loaded once: a scan the serial cannot explain may still name its operator,
  // and that operator is the person who should be sorting it out.
  const staff = await db.user.findMany({
    where: { organizationId, active: true },
    select: { id: true, name: true, active: true },
  });

  const touched = new Set<string>();
  let matched = 0;
  let assignedByOperator = 0;

  for (const m of pending) {
    const result = await matchSerial(organizationId, m.serial);
    if (result.status !== "MATCHED") {
      // No sample explains this scan. If the rig recorded an operator and that
      // name resolves to exactly one active account, hand it to them rather
      // than leaving it in the shared orphan pile. An existing owner is never
      // overwritten — a manager's decision outranks a name on a file.
      const owner = m.assignedToId
        ? null
        : matchOperatorToUser(m.operator, staff);
      // Refresh the reason — the experiment may exist now but the sample not.
      await db.$transaction(async (transaction) => {
        await transaction.jvMeasurement.update({
          where: { id: m.id },
          data: {
            matchNote: result.matchNote,
            ...(owner ? { assignedToId: owner.id } : {}),
          },
        });
        await recordSystemAudit(transaction, {
          organizationId,
          action: owner
            ? "instrument.measurement.assigned_by_operator"
            : "instrument.measurement.rematch_failed",
          entityType: "JvMeasurement",
          entityId: m.id,
          metadata: owner
            ? { reason: result.matchNote, operator: m.operator }
            : { reason: result.matchNote },
          ...(owner ? { changes: { assignedToId: owner.id } } : {}),
        });
      });
      if (owner) assignedByOperator++;
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
    assignedByOperator,
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
