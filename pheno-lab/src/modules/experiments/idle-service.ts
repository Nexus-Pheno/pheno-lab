import "server-only";

import { db } from "@/infrastructure/db/client";
import { log } from "@/infrastructure/logging/logger";
import type { Actor } from "@/modules/authorization/actor";
import { recordSystemAudit, recordUserAudit } from "@/modules/audit/writer";
import { notify } from "@/modules/notifications/service";
import { assertEdit } from "./access";
import { idleDecision } from "./idle-policy";
import { experimentIdSchema } from "./schema";

// The nightly sweep behind the idle-draft policy (see idle-policy.ts). Runs
// as the system actor from the same cron entry as the morning digest.
//
// Two details keep it honest:
//   - its own writes must not count as activity: the audit rows it leaves
//     are excluded from the activity query, and the experiment's updatedAt
//     is pinned so the housekeeping update does not refresh it;
//   - a draft is judged by every edit inside it, not just the row — most
//     designer work lands on steps, which have no timestamp of their own,
//     so the audit trail is the clock.

const SYSTEM_ACTOR_NAME = "Pheno Lab";

type Draft = {
  id: string;
  organizationId: string;
  code: string;
  title: string;
  createdById: string;
  updatedAt: Date;
  idleWarnedAt: Date | null;
  steps: { id: string }[];
  characterizations: { id: string }[];
  samples: { id: string }[];
};

async function lastActivityOf(draft: Draft): Promise<Date> {
  const ids = [
    draft.id,
    ...draft.steps.map((s) => s.id),
    ...draft.characterizations.map((c) => c.id),
    ...draft.samples.map((s) => s.id),
  ];
  const [audit, comment] = await Promise.all([
    db.auditEvent.findFirst({
      where: {
        organizationId: draft.organizationId,
        entityId: { in: ids },
        NOT: { action: { startsWith: "experiment.idle_" } },
      },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    db.experimentComment.findFirst({
      where: { experimentId: draft.id },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
  ]);
  return new Date(
    Math.max(
      draft.updatedAt.getTime(),
      audit?.createdAt.getTime() ?? 0,
      comment?.createdAt.getTime() ?? 0,
    ),
  );
}

export type IdleSweepResult = {
  scanned: number;
  warned: number;
  archived: number;
  reset: number;
};

export async function sweepIdleDrafts(
  now = new Date(),
): Promise<IdleSweepResult> {
  const drafts = await db.experiment.findMany({
    where: { status: "DRAFT", isTest: false, deletedAt: null },
    select: {
      id: true,
      organizationId: true,
      code: true,
      title: true,
      createdById: true,
      updatedAt: true,
      idleWarnedAt: true,
      steps: { select: { id: true } },
      characterizations: { select: { id: true } },
      samples: { select: { id: true } },
    },
  });
  const result: IdleSweepResult = {
    scanned: drafts.length,
    warned: 0,
    archived: 0,
    reset: 0,
  };

  for (const draft of drafts) {
    const lastActivityAt = await lastActivityOf(draft);
    const decision = idleDecision({
      now,
      lastActivityAt,
      warnedAt: draft.idleWarnedAt,
    });
    if (decision === "none") continue;
    const label = draft.title.trim() || draft.code;
    const href = `/experiments/${draft.id}`;
    try {
      await db.$transaction(async (tx) => {
        if (decision === "reset") {
          await tx.experiment.update({
            where: { id: draft.id },
            data: { idleWarnedAt: null, updatedAt: draft.updatedAt },
          });
          result.reset += 1;
          return;
        }
        if (decision === "warn") {
          await tx.experiment.update({
            where: { id: draft.id },
            data: { idleWarnedAt: now, updatedAt: draft.updatedAt },
          });
          await recordSystemAudit(tx, {
            organizationId: draft.organizationId,
            action: "experiment.idle_warned",
            entityType: "Experiment",
            entityId: draft.id,
            metadata: { lastActivityAt: lastActivityAt.toISOString() },
          });
          await notify(tx, {
            organizationId: draft.organizationId,
            userId: draft.createdById,
            actorUserId: "system",
            kind: "draft_idle_warning",
            actorName: SYSTEM_ACTOR_NAME,
            entityLabel: label,
            href,
          });
          result.warned += 1;
          return;
        }
        // archive
        await tx.experiment.update({
          where: { id: draft.id },
          data: {
            status: "ARCHIVED",
            idleArchivedAt: now,
            updatedAt: draft.updatedAt,
          },
        });
        await recordSystemAudit(tx, {
          organizationId: draft.organizationId,
          action: "experiment.idle_archived",
          entityType: "Experiment",
          entityId: draft.id,
          metadata: { lastActivityAt: lastActivityAt.toISOString() },
        });
        await notify(tx, {
          organizationId: draft.organizationId,
          userId: draft.createdById,
          actorUserId: "system",
          kind: "draft_idle_archived",
          actorName: SYSTEM_ACTOR_NAME,
          entityLabel: label,
          href,
        });
        result.archived += 1;
      });
    } catch (error) {
      log.error("idle-draft sweep failed for an experiment", {
        experimentId: draft.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}

/**
 * One click brings an idle-archived draft back as a draft, content intact.
 * Only archives the sweep made are renewable this way; a deliberate archive
 * is a decision, not housekeeping.
 */
export async function renewIdleDraft(
  actor: Actor,
  rawId: unknown,
): Promise<void> {
  const id = experimentIdSchema.parse(rawId);
  await assertEdit(actor, id);
  await db.$transaction(async (tx) => {
    const result = await tx.experiment.updateMany({
      where: {
        id,
        organizationId: actor.org,
        status: "ARCHIVED",
        idleArchivedAt: { not: null },
      },
      data: { status: "DRAFT", idleArchivedAt: null, idleWarnedAt: null },
    });
    if (result.count !== 1)
      throw new Error("This experiment was not archived for inactivity.");
    await recordUserAudit(tx, {
      actor,
      action: "experiment.idle_renewed",
      entityType: "Experiment",
      entityId: id,
    });
  });
}
