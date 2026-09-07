import "server-only";

import { z } from "zod";
import { db } from "@/infrastructure/db/client";
import type { Actor } from "@/modules/authorization/actor";
import { requireExperimentPermission } from "@/modules/authorization/service";
import { recordUserAudit } from "@/modules/audit/writer";
import { notify } from "@/modules/notifications/service";
import { experimentIdSchema } from "./schema";

// Experiment discussion. Reading the experiment is the only gate — the
// thread is where a manager asks "why did group B drop?" and the technician
// answers next to the data. Mentions arrive as user ids picked from the
// composer's @ popup (never parsed out of free text) and only produce bell
// notifications; a mentioned outsider still lands on the request-access page.

const commentSchema = z.object({
  experimentId: experimentIdSchema,
  body: z.string().trim().min(1).max(5000),
  mentionIds: z.array(experimentIdSchema).max(10).default([]),
});

export type CommentRow = {
  id: string;
  author: string;
  authorId: string;
  body: string;
  createdAt: string;
};

const toRow = (row: {
  id: string;
  authorId: string;
  body: string;
  createdAt: Date;
  author: { name: string };
}): CommentRow => ({
  id: row.id,
  author: row.author.name,
  authorId: row.authorId,
  body: row.body,
  createdAt: row.createdAt.toISOString(),
});

export async function listComments(
  actor: Actor,
  rawExperimentId: unknown,
): Promise<CommentRow[]> {
  const experimentId = experimentIdSchema.parse(rawExperimentId);
  await requireExperimentPermission(actor, experimentId, "read");
  const rows = await db.experimentComment.findMany({
    where: { experimentId },
    orderBy: { createdAt: "asc" },
    include: { author: { select: { name: true } } },
  });
  return rows.map(toRow);
}

export async function addComment(
  actor: Actor,
  raw: unknown,
): Promise<CommentRow> {
  const { experimentId, body, mentionIds } = commentSchema.parse(raw);
  await requireExperimentPermission(actor, experimentId, "read");

  const created = await db.$transaction(async (tx) => {
    const experiment = await tx.experiment.findUniqueOrThrow({
      where: { id: experimentId },
      select: { code: true, title: true, createdById: true },
    });
    const author = await tx.user.findUniqueOrThrow({
      where: { id: actor.uid },
      select: { name: true },
    });
    const comment = await tx.experimentComment.create({
      data: { experimentId, authorId: actor.uid, body },
      include: { author: { select: { name: true } } },
    });

    // Mentions are validated against the org — a pasted foreign id is
    // silently dropped rather than leaking a notification cross-org.
    const mentioned = mentionIds.length
      ? await tx.user.findMany({
          where: {
            id: { in: mentionIds },
            organizationId: actor.org,
            active: true,
          },
          select: { id: true },
        })
      : [];
    const label = `${experiment.code} · ${experiment.title}`;
    const href = `/experiments/${experimentId}`;
    const notified = new Set<string>();
    for (const user of mentioned) {
      notified.add(user.id);
      await notify(tx, {
        organizationId: actor.org,
        userId: user.id,
        actorUserId: actor.uid,
        kind: "mentioned",
        actorName: author.name,
        entityLabel: label,
        href,
      });
    }
    // The owner hears about every comment on their experiment — unless the
    // mention already covered them (or they wrote it; notify() skips self).
    if (!notified.has(experiment.createdById)) {
      await notify(tx, {
        organizationId: actor.org,
        userId: experiment.createdById,
        actorUserId: actor.uid,
        kind: "experiment_commented",
        actorName: author.name,
        entityLabel: label,
        href,
      });
    }
    await recordUserAudit(tx, {
      actor,
      action: "experiment.commented",
      entityType: "Experiment",
      entityId: experimentId,
      metadata: { commentId: comment.id, mentions: mentioned.length },
    });
    return comment;
  });
  return toRow(created);
}

/** Authors delete their own comments; experiment managers can moderate. */
export async function deleteComment(
  actor: Actor,
  rawCommentId: unknown,
): Promise<void> {
  const commentId = experimentIdSchema.parse(rawCommentId);
  const comment = await db.experimentComment.findFirst({
    where: { id: commentId, experiment: { organizationId: actor.org } },
    select: { id: true, authorId: true, experimentId: true },
  });
  if (!comment) throw new Error("No such comment.");
  if (comment.authorId !== actor.uid)
    await requireExperimentPermission(actor, comment.experimentId, "manage");
  await db.$transaction(async (tx) => {
    await tx.experimentComment.delete({ where: { id: comment.id } });
    await recordUserAudit(tx, {
      actor,
      action: "experiment.comment_deleted",
      entityType: "Experiment",
      entityId: comment.experimentId,
      metadata: { commentId: comment.id },
    });
  });
}
