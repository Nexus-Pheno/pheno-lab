import "server-only";

import { db } from "@/infrastructure/db/client";
import type { Actor } from "@/modules/authorization/actor";
import { AuthorizationError, isStaff } from "@/modules/authorization/policy";
import { recordSystemAudit, recordUserAudit } from "@/modules/audit/writer";
import { experimentIdSchema } from "./schema";

// The recycle bin (团队反馈 2026-09-08). Trashing keeps every child row —
// samples, runs, results, comments — so restore is loss-free. Trashed rows
// are invisible to every scope; this service is the only code allowed to
// touch them, and it checks its own permissions because the normal
// requireExperimentPermission gate rejects trashed experiments by design.

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Staff restore anything; a technician can restore what they created, ran, or deleted. */
function canRecover(
  actor: Actor,
  row: {
    createdById: string;
    assigneeId: string | null;
    deletedById: string | null;
  },
): boolean {
  return (
    isStaff(actor) ||
    row.createdById === actor.uid ||
    row.assigneeId === actor.uid ||
    row.deletedById === actor.uid
  );
}

export type TrashRow = {
  id: string;
  code: string;
  title: string;
  isTest: boolean;
  deletedAt: string;
  deletedBy: string;
  samples: number;
  /** Whether this actor may restore it (purge stays staff-only). */
  restorable: boolean;
  purgeAt: string;
};

/**
 * The org's recycle bin, scoped like editing: staff see everything,
 * technicians see the entries they could restore. Listing also lazily purges
 * anything past retention — no extra cron, and a bin nobody opens simply
 * keeps its (hidden) rows a little longer.
 */
export async function listTrash(actor: Actor): Promise<TrashRow[]> {
  const expired = new Date(Date.now() - RETENTION_MS);
  const stale = await db.experiment.findMany({
    where: { organizationId: actor.org, deletedAt: { lt: expired } },
    select: { id: true },
  });
  if (stale.length) {
    await db.$transaction(async (tx) => {
      const result = await tx.experiment.deleteMany({
        where: { id: { in: stale.map((row) => row.id) } },
      });
      await recordSystemAudit(tx, {
        organizationId: actor.org,
        action: "experiment.trash.auto_purged",
        entityType: "Organization",
        entityId: actor.org,
        metadata: { count: result.count },
      });
    });
  }

  const rows = await db.experiment.findMany({
    where: { organizationId: actor.org, deletedAt: { not: null } },
    orderBy: { deletedAt: "desc" },
    select: {
      id: true,
      code: true,
      title: true,
      isTest: true,
      createdById: true,
      assigneeId: true,
      deletedAt: true,
      deletedById: true,
      deletedBy: { select: { name: true } },
      _count: { select: { samples: true } },
    },
  });
  return rows
    .filter((row) => canRecover(actor, row))
    .map((row) => ({
      id: row.id,
      code: row.code,
      title: row.title,
      isTest: row.isTest,
      deletedAt: row.deletedAt!.toISOString().replace("T", " ").slice(0, 16),
      deletedBy: row.deletedBy?.name ?? "?",
      samples: row._count.samples,
      restorable: true,
      purgeAt: new Date(row.deletedAt!.getTime() + RETENTION_MS)
        .toISOString()
        .slice(0, 10),
    }));
}

export async function restoreExperiment(actor: Actor, rawId: unknown) {
  const id = experimentIdSchema.parse(rawId);
  const row = await db.experiment.findFirst({
    where: { id, organizationId: actor.org, deletedAt: { not: null } },
    select: {
      id: true,
      createdById: true,
      assigneeId: true,
      deletedById: true,
    },
  });
  if (!row) throw new Error("Not in the recycle bin.");
  if (!canRecover(actor, row))
    throw new AuthorizationError("Not yours to restore.");
  await db.$transaction(async (tx) => {
    await tx.experiment.update({
      where: { id },
      data: { deletedAt: null, deletedById: null },
    });
    await recordUserAudit(tx, {
      actor,
      action: "experiment.restore",
      entityType: "Experiment",
      entityId: id,
    });
  });
}

/** The true, irreversible delete — staff only. */
export async function purgeExperiment(actor: Actor, rawId: unknown) {
  const id = experimentIdSchema.parse(rawId);
  if (!isStaff(actor))
    throw new AuthorizationError("Only staff may purge the recycle bin.");
  const row = await db.experiment.findFirst({
    where: { id, organizationId: actor.org, deletedAt: { not: null } },
    select: { id: true, code: true },
  });
  if (!row) throw new Error("Not in the recycle bin.");
  await db.$transaction(async (tx) => {
    await tx.experiment.delete({ where: { id } });
    await recordUserAudit(tx, {
      actor,
      action: "experiment.purge",
      entityType: "Experiment",
      entityId: id,
      metadata: { code: row.code },
    });
  });
}
