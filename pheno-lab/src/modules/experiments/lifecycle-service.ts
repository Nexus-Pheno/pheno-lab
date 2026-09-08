import "server-only";

import type { Prisma } from "@prisma/client";
import { db } from "@/infrastructure/db/client";
import { experimentInclude } from "@/lib/types";
import type { Actor } from "@/modules/authorization/actor";
import { assertStaff } from "@/modules/authorization/policy";
import { requireExperimentPermission } from "@/modules/authorization/service";
import { recordUserAudit } from "@/modules/audit/writer";
import { syncSampleSerials } from "@/modules/instruments/sample-serial-service";
import { assertEdit } from "./access";
import { syncAutoLabels } from "./plan-service";
import { experimentIdSchema, experimentMetaSchema } from "./schema";

// Experiment codes are YYYY-ORG-USER-SEQ: year, organization number (Pheno =
// 001), the creator's user number, and their monotonically increasing
// experiment sequence — never reused, no ceiling, unique across the org.
async function nextExperimentCode(
  tx: Prisma.TransactionClient,
  actor: Actor,
): Promise<string> {
  const org = await tx.organization.findUniqueOrThrow({
    where: { id: actor.org },
    select: { orgNumber: true },
  });
  const user = await tx.user.update({
    where: { id: actor.uid, organizationId: actor.org },
    data: { nextExpSeq: { increment: 1 } },
  });
  const seq = user.nextExpSeq - 1;
  return `${new Date().getFullYear()}-${String(org.orgNumber).padStart(3, "0")}-${user.userNumber}-${seq}`;
}

export async function createExperiment(actor: Actor, isTest = false) {
  // Everyone runs their own experiments now (Michael, 2026-09-07); only the
  // test-data sandbox stays staff-only.
  if (isTest) assertStaff(actor);
  const exp = await db.$transaction(async (tx) => {
    const code = await nextExperimentCode(tx, actor);
    const created = await tx.experiment.create({
      data: {
        organizationId: actor.org,
        code,
        title: isTest ? "Untitled test experiment" : "Untitled experiment",
        isTest,
        createdById: actor.uid,
        samples: {
          create: [
            { code: "S1" },
            { code: "S2" },
            { code: "S3" },
            { code: "S4" },
          ],
        },
      },
    });
    // The experiment, its short handle, sample serials, and audit event form
    // one unit. A failure cannot leave a partially initialized experiment.
    await syncSampleSerials(tx, created.id);
    await recordUserAudit(tx, {
      actor,
      action: "experiment.create",
      entityType: "Experiment",
      entityId: created.id,
      changes: { code: created.code, isTest },
    });
    return created;
  });
  return exp;
}

export async function updateExperimentMeta(
  actor: Actor,
  id: string,
  raw: unknown,
) {
  id = experimentIdSchema.parse(id);
  const data = experimentMetaSchema.parse(raw);
  await assertEdit(actor, id);
  await db.$transaction(async (tx) => {
    await tx.experiment.update({ where: { id }, data });
    await recordUserAudit(tx, {
      actor,
      action: "experiment.update",
      entityType: "Experiment",
      entityId: id,
      changes: data,
    });
  });
}

// "Delete" trashes: the row keeps everything (code, serials, runs, results)
// and hides from every scope until restored or purged (团队反馈 2026-09-08).
export async function deleteExperiment(actor: Actor, rawId: unknown) {
  const id = experimentIdSchema.parse(rawId);
  await assertEdit(actor, id);
  await db.$transaction(async (tx) => {
    await tx.experiment.update({
      where: { id },
      data: { deletedAt: new Date(), deletedById: actor.uid },
    });
    await recordUserAudit(tx, {
      actor,
      action: "experiment.trash",
      entityType: "Experiment",
      entityId: id,
    });
  });
}

/** Duplicate an experiment's full plan — no run data. */
export async function duplicateExperiment(actor: Actor, rawId: unknown) {
  const id = experimentIdSchema.parse(rawId);
  const src = await db.experiment.findFirst({
    where: { id, organizationId: actor.org, deletedAt: null },
    include: experimentInclude,
  });
  if (!src) throw new Error("Experiment belongs to another organization.");
  // Copying a plan requires being able to open the source experiment — unless
  // it is pinned as an org-wide template, whose whole point is that anyone in
  // the lab can start from it.
  const isTemplate = src.templatePinnedAt !== null && !src.isTest;
  if (!isTemplate) await requireExperimentPermission(actor, id, "read");

  const copy = await db.$transaction(async (tx) => {
    const code = await nextExperimentCode(tx, actor);
    const created = await tx.experiment.create({
      data: {
        organizationId: actor.org,
        code,
        // A template's name is a starting point, not a provenance marker.
        title: isTemplate ? src.title : `${src.title} (copy)`,
        campaign: src.campaign,
        status: "DRAFT",
        isTest: src.isTest,
        observation: src.observation,
        problem: src.problem,
        hypothesis: src.hypothesis,
        metadata: src.metadata ?? undefined,
        createdById: actor.uid,
        members: { create: [{ userId: actor.uid }] },
        // Serials are NOT copied: the duplicate is a different experiment and
        // gets its own short handle, or both would answer to the same serial.
        samples: {
          create: src.samples.map((sample) => ({
            code: sample.code,
            variationGroup: sample.variationGroup,
            note: sample.note,
          })),
        },
      },
    });
    await syncSampleSerials(tx, created.id);

    for (const step of src.steps) {
      await tx.processStep.create({
        data: {
          experimentId: created.id,
          position: step.position,
          processId: step.processId,
          name: step.name,
          equipmentId: step.equipmentId,
          environmentId: step.environmentId,
          environmentConditions: step.environmentConditions ?? undefined,
          layer: step.layer,
          recipeId: step.recipeId,
          notes: step.notes,
          materials: {
            create: step.materials.map((material) => ({
              materialId: material.materialId,
              amount: material.amount,
              position: material.position,
            })),
          },
          parameters: {
            create: step.parameters.map((parameter) => ({
              position: parameter.position,
              name: parameter.name,
              unit: parameter.unit,
              value: parameter.value,
              source: parameter.source,
              variations: {
                create: parameter.variations.map((variation) => ({
                  variationGroup: variation.variationGroup,
                  value: variation.value,
                })),
              },
            })),
          },
        },
      });
    }
    for (const characterization of src.characterizations) {
      await tx.characterization.create({
        data: {
          experimentId: created.id,
          position: characterization.position,
          processId: characterization.processId,
          name: characterization.name,
          equipmentId: characterization.equipmentId,
          environmentId: characterization.environmentId,
          environmentConditions:
            characterization.environmentConditions ?? undefined,
          settings: characterization.settings ?? undefined,
          sampleScope: characterization.sampleScope,
          notes: characterization.notes,
        },
      });
    }
    await recordUserAudit(tx, {
      actor,
      action: "experiment.duplicate",
      entityType: "Experiment",
      entityId: created.id,
      metadata: { sourceExperimentId: id },
    });
    return created;
  });
  await syncAutoLabels(copy.id);
  return { id: copy.id, code: copy.code };
}

/** Staff-only: pin/unpin an experiment as an org-wide starting template. */
export async function setTemplatePin(
  actor: Actor,
  rawId: unknown,
  pinned: boolean,
) {
  assertStaff(actor);
  const id = experimentIdSchema.parse(rawId);
  const experiment = await db.experiment.findFirst({
    where: { id, organizationId: actor.org, deletedAt: null },
    select: { id: true, isTest: true },
  });
  if (!experiment) throw new Error("No such experiment.");
  if (pinned && experiment.isTest)
    throw new Error("Test experiments cannot be templates.");
  await db.$transaction(async (tx) => {
    await tx.experiment.update({
      where: { id },
      data: { templatePinnedAt: pinned ? new Date() : null },
    });
    await recordUserAudit(tx, {
      actor,
      action: pinned
        ? "experiment.template_pinned"
        : "experiment.template_unpinned",
      entityType: "Experiment",
      entityId: id,
      changes: { pinned },
    });
  });
}
