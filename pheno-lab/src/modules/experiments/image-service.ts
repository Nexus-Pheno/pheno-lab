import "server-only";

import { z } from "zod";
import { db } from "@/infrastructure/db/client";
import type { Actor } from "@/modules/authorization/actor";
import { recordUserAudit } from "@/modules/audit/writer";
import { requireOwnedUploadKeys } from "@/modules/files/service";
import { assertEdit } from "./access";

// Images on the science fields — an IV curve in 观察, a film photo in 问题
// (Tyler's feedback, 2026-09-08). Same pen as the text: whoever may edit the
// experiment may attach or remove; readers see them via canReadObject.

const contextSchema = z.enum([
  "observation",
  "problem",
  "hypothesis",
  "conclusion",
]);
const imagesSchema = z.object({
  experimentId: z.string().min(1).max(128),
  context: contextSchema,
  fileNames: z.array(z.string().max(512)).min(1).max(10),
});

export type ExperimentImage = { id: string; path: string; context: string };

export async function addExperimentImages(
  actor: Actor,
  raw: unknown,
): Promise<ExperimentImage[]> {
  const { experimentId, context, fileNames } = imagesSchema.parse(raw);
  await assertEdit(actor, experimentId);
  await requireOwnedUploadKeys(actor, fileNames);
  return db.$transaction(async (tx) => {
    await tx.attachment.createMany({
      data: fileNames.map((key) => ({
        experimentId,
        context,
        fileName: key.split("/").pop() ?? key,
        storedPath: key,
        mime: "image/*",
        size: 0,
      })),
    });
    await recordUserAudit(tx, {
      actor,
      action: "experiment.image.attach",
      entityType: "Experiment",
      entityId: experimentId,
      metadata: { context, count: fileNames.length },
    });
    const rows = await tx.attachment.findMany({
      where: { experimentId, context, commentId: null },
      orderBy: { createdAt: "asc" },
      select: { id: true, storedPath: true, context: true },
    });
    return rows.map((row) => ({
      id: row.id,
      path: row.storedPath,
      context: row.context,
    }));
  });
}

export async function deleteExperimentImage(actor: Actor, rawId: unknown) {
  const id = z.string().min(1).max(128).parse(rawId);
  const row = await db.attachment.findFirst({
    where: { id, experimentId: { not: null } },
    select: { id: true, experimentId: true, context: true },
  });
  if (!row?.experimentId) throw new Error("Image not found.");
  const experimentId = row.experimentId;
  await assertEdit(actor, experimentId);
  await db.$transaction(async (tx) => {
    await tx.attachment.delete({ where: { id } });
    await recordUserAudit(tx, {
      actor,
      action: "experiment.image.detach",
      entityType: "Experiment",
      entityId: experimentId,
      metadata: { context: row.context },
    });
  });
}
