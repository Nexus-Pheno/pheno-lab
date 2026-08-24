import "server-only";

import type { Prisma } from "@prisma/client";
import { db } from "@/infrastructure/db/client";
import { experimentInclude } from "@/lib/types";
import type { Actor } from "@/modules/authorization/actor";
import { assertStaff } from "@/modules/authorization/policy";
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
  assertStaff(actor);
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

export async function deleteExperiment(actor: Actor, rawId: unknown) {
  const id = experimentIdSchema.parse(rawId);
  await assertEdit(actor, id);
  await db.$transaction(async (tx) => {
    await tx.experiment.delete({ where: { id } });
    await recordUserAudit(tx, {
      actor,
      action: "experiment.delete",
      entityType: "Experiment",
      entityId: id,
    });
  });
}

/** Phase 2: duplicate an experiment as a template — full plan, no run data. */
export async function duplicateExperiment(actor: Actor, rawId: unknown) {
  assertStaff(actor);
  const id = experimentIdSchema.parse(rawId);
  const src = await db.experiment.findUniqueOrThrow({
    where: { id },
    include: experimentInclude,
  });
  if (src.organizationId !== actor.org)
    throw new Error("Experiment belongs to another organization.");

  const copy = await db.$transaction(async (tx) => {
    const code = await nextExperimentCode(tx, actor);
    const created = await tx.experiment.create({
      data: {
        organizationId: actor.org,
        code,
        title: `${src.title} (copy)`,
        campaign: src.campaign,
        status: "DRAFT",
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
