import "server-only";

import { Prisma } from "@prisma/client";
import { db } from "@/infrastructure/db/client";
import { objectStorage } from "@/infrastructure/storage";
import type { Actor } from "@/modules/authorization/actor";
import { requireExperimentPermission } from "@/modules/authorization/service";
import { recordUserAudit } from "@/modules/audit/writer";
import type {
  characterizationResultSchema,
  executionBatchSchema,
} from "./schema";
import type { z } from "zod";

type ExecutionBatchInput = z.infer<typeof executionBatchSchema>;
type CharacterizationResultInput = z.infer<typeof characterizationResultSchema>;

async function requireCaptureGraph(
  actor: Actor,
  input: Pick<ExecutionBatchInput, "runId" | "stepId" | "sampleIds">,
): Promise<string> {
  const [run, step, samples] = await Promise.all([
    db.run.findUniqueOrThrow({
      where: { id: input.runId },
      select: { experimentId: true },
    }),
    db.processStep.findUniqueOrThrow({
      where: { id: input.stepId },
      select: { experimentId: true },
    }),
    db.sample.findMany({
      where: { id: { in: input.sampleIds } },
      select: { id: true, experimentId: true },
    }),
  ]);

  if (
    step.experimentId !== run.experimentId ||
    samples.length !== input.sampleIds.length ||
    samples.some((sample) => sample.experimentId !== run.experimentId)
  ) {
    throw new Error(
      "Run, step, and samples must belong to the same experiment.",
    );
  }
  await requireExperimentPermission(actor, run.experimentId, "capture");
  return run.experimentId;
}

async function requireOwnedUploadKeys(
  actor: Actor,
  keys: string[],
): Promise<void> {
  const prefix = `organizations/${actor.org}/users/${actor.uid}/images/`;
  for (const key of keys) {
    if (!key.startsWith(prefix) || !(await objectStorage().exists(key))) {
      throw new Error(
        "A capture image is missing or does not belong to this user.",
      );
    }
  }
}

export async function getOrCreateRunService(
  actor: Actor,
  experimentId: string,
) {
  await requireExperimentPermission(actor, experimentId, "capture");
  const existing = await db.run.findFirst({
    where: { experimentId },
    orderBy: { runNo: "desc" },
  });
  if (existing) return existing;
  return db.$transaction(async (transaction) => {
    const run = await transaction.run.create({
      data: {
        experimentId,
        runNo: 1,
        status: "IN_PROGRESS",
        technicianId: actor.uid,
      },
    });
    await recordUserAudit(transaction, {
      actor,
      action: "run.create",
      entityType: "Run",
      entityId: run.id,
      metadata: { experimentId, runNo: 1 },
    });
    return run;
  });
}

export async function createNewRunService(actor: Actor, experimentId: string) {
  await requireExperimentPermission(actor, experimentId, "capture");
  return db.$transaction(async (transaction) => {
    const latest = await transaction.run.findFirst({
      where: { experimentId },
      orderBy: { runNo: "desc" },
      select: { runNo: true },
    });
    const run = await transaction.run.create({
      data: {
        experimentId,
        runNo: (latest?.runNo ?? 0) + 1,
        status: "IN_PROGRESS",
        technicianId: actor.uid,
      },
    });
    await recordUserAudit(transaction, {
      actor,
      action: "run.create",
      entityType: "Run",
      entityId: run.id,
      metadata: { experimentId, runNo: run.runNo },
    });
    return run;
  });
}

export async function saveExecutionBatchService(
  actor: Actor,
  input: ExecutionBatchInput,
) {
  const experimentId = await requireCaptureGraph(actor, input);
  const photos = input.data.photoFileNames ?? [];
  await requireOwnedUploadKeys(actor, photos);

  const executionIds = await db.$transaction(async (transaction) => {
    const ids: string[] = [];
    for (const sampleId of input.sampleIds) {
      const execution = await transaction.stepExecution.upsert({
        where: {
          runId_stepId_sampleId: {
            runId: input.runId,
            stepId: input.stepId,
            sampleId,
          },
        },
        update: {
          actuals: input.data.actuals,
          environmentConditions: input.data.environmentConditions,
          note: input.data.note,
          flagged: input.data.flagged,
          capturedAt: new Date(),
        },
        create: {
          runId: input.runId,
          stepId: input.stepId,
          sampleId,
          actuals: input.data.actuals,
          environmentConditions: input.data.environmentConditions,
          note: input.data.note,
          flagged: input.data.flagged,
        },
      });
      ids.push(execution.id);
      for (const key of photos) {
        await transaction.attachment.create({
          data: {
            fileName: key,
            storedPath: key,
            mime: "image/*",
            size: 0,
            stepExecutionId: execution.id,
          },
        });
      }
    }
    await recordUserAudit(transaction, {
      actor,
      action: "capture.execution.save",
      entityType: "Run",
      entityId: input.runId,
      changes: {
        experimentId,
        stepId: input.stepId,
        sampleIds: input.sampleIds,
        flagged: input.data.flagged,
        photoCount: photos.length,
      },
    });
    return ids;
  });

  return db.stepExecution.findMany({
    where: { id: { in: executionIds } },
    include: { attachments: true },
  });
}

export async function deleteExecutionPhotoService(
  actor: Actor,
  attachmentId: string,
): Promise<void> {
  const attachment = await db.attachment.findUniqueOrThrow({
    where: { id: attachmentId },
    include: {
      stepExecution: {
        include: { run: { select: { id: true, experimentId: true } } },
      },
    },
  });
  if (!attachment.stepExecution) throw new Error("Not a capture photo.");
  await requireExperimentPermission(
    actor,
    attachment.stepExecution.run.experimentId,
    "capture",
  );
  await db.$transaction(async (transaction) => {
    const deleted = await transaction.attachment.deleteMany({
      where: {
        storedPath: attachment.storedPath,
        stepExecution: {
          runId: attachment.stepExecution!.runId,
          stepId: attachment.stepExecution!.stepId,
        },
      },
    });
    await recordUserAudit(transaction, {
      actor,
      action: "capture.photo.detach",
      entityType: "Run",
      entityId: attachment.stepExecution!.run.id,
      metadata: { attachmentId, referencesRemoved: deleted.count },
    });
  });
}

export async function addExecutionPhotosService(
  actor: Actor,
  input: Pick<ExecutionBatchInput, "runId" | "stepId" | "sampleIds"> & {
    fileNames: string[];
  },
) {
  await requireCaptureGraph(actor, input);
  await requireOwnedUploadKeys(actor, input.fileNames);
  const referenceId = await db.$transaction(async (transaction) => {
    const executions = await transaction.stepExecution.findMany({
      where: {
        runId: input.runId,
        stepId: input.stepId,
        sampleId: { in: input.sampleIds },
      },
    });
    for (const execution of executions) {
      for (const key of input.fileNames) {
        await transaction.attachment.create({
          data: {
            fileName: key,
            storedPath: key,
            mime: "image/*",
            size: 0,
            stepExecutionId: execution.id,
          },
        });
      }
    }
    await recordUserAudit(transaction, {
      actor,
      action: "capture.photo.attach",
      entityType: "Run",
      entityId: input.runId,
      metadata: {
        stepId: input.stepId,
        sampleCount: input.sampleIds.length,
        photoCount: input.fileNames.length,
      },
    });
    return executions[0]?.id;
  });
  if (!referenceId) return [];
  const attachments = await db.attachment.findMany({
    where: { stepExecutionId: referenceId },
    orderBy: { createdAt: "asc" },
  });
  return attachments.map((attachment) => ({
    id: attachment.id,
    path: attachment.storedPath,
  }));
}

export async function clearExecutionsService(
  actor: Actor,
  input: Pick<ExecutionBatchInput, "runId" | "stepId" | "sampleIds">,
): Promise<void> {
  await requireCaptureGraph(actor, input);
  await db.$transaction(async (transaction) => {
    const deleted = await transaction.stepExecution.deleteMany({
      where: {
        runId: input.runId,
        stepId: input.stepId,
        sampleId: { in: input.sampleIds },
      },
    });
    await recordUserAudit(transaction, {
      actor,
      action: "capture.execution.clear",
      entityType: "Run",
      entityId: input.runId,
      metadata: { stepId: input.stepId, executionsRemoved: deleted.count },
    });
  });
}

export async function completeExperimentService(
  actor: Actor,
  experimentId: string,
): Promise<void> {
  await requireExperimentPermission(actor, experimentId, "capture");
  await db.$transaction(async (transaction) => {
    await transaction.experiment.update({
      where: { id: experimentId },
      data: { status: "COMPLETE" },
    });
    await recordUserAudit(transaction, {
      actor,
      action: "experiment.complete-from-capture",
      entityType: "Experiment",
      entityId: experimentId,
      changes: { status: "COMPLETE" },
    });
  });
}

export async function saveCharacterizationResultService(
  actor: Actor,
  input: CharacterizationResultInput,
) {
  const [characterization, sample, run] = await Promise.all([
    db.characterization.findUniqueOrThrow({
      where: { id: input.characterizationId },
      select: { experimentId: true },
    }),
    db.sample.findUniqueOrThrow({
      where: { id: input.sampleId },
      select: { experimentId: true },
    }),
    input.runId
      ? db.run.findUniqueOrThrow({
          where: { id: input.runId },
          select: { experimentId: true },
        })
      : Promise.resolve(null),
  ]);
  if (
    sample.experimentId !== characterization.experimentId ||
    (run && run.experimentId !== characterization.experimentId)
  ) {
    throw new Error(
      "Characterization, sample, and run must belong to the same experiment.",
    );
  }
  await requireExperimentPermission(
    actor,
    characterization.experimentId,
    "capture",
  );

  return db.$transaction(async (transaction) => {
    const existing = await transaction.characterizationResult.findFirst({
      where: {
        characterizationId: input.characterizationId,
        sampleId: input.sampleId,
        runId: input.runId ?? null,
      },
    });
    const result = existing
      ? await transaction.characterizationResult.update({
          where: { id: existing.id },
          data: {
            metrics: input.metrics as Prisma.InputJsonValue,
            note: input.note,
            capturedAt: new Date(),
          },
        })
      : await transaction.characterizationResult.create({
          data: {
            characterizationId: input.characterizationId,
            sampleId: input.sampleId,
            runId: input.runId ?? null,
            metrics: input.metrics as Prisma.InputJsonValue,
            note: input.note,
          },
        });
    await recordUserAudit(transaction, {
      actor,
      action: "capture.characterization.save",
      entityType: "CharacterizationResult",
      entityId: result.id,
      changes: {
        characterizationId: input.characterizationId,
        sampleId: input.sampleId,
        runId: input.runId,
        metrics: input.metrics,
      },
    });
    return result;
  });
}

/**
 * Mid-experiment substrate swap: the technician drags a sample into another
 * variable group, back to the Extras pool, or into Error when it is scrapped.
 * Codes and sim codes never change — only group membership does. The stored
 * test plan's assignments follow so the designer shows the same picture.
 */
export async function regroupSampleService(
  actor: Actor,
  sampleId: string,
  zone: string,
) {
  const sample = await db.sample.findUniqueOrThrow({
    where: { id: sampleId },
    select: { id: true, code: true, experimentId: true },
  });
  await requireExperimentPermission(actor, sample.experimentId, "capture");
  const experiment = await db.experiment.findUniqueOrThrow({
    where: { id: sample.experimentId },
    select: { metadata: true },
  });
  const metadata = (experiment.metadata ?? {}) as Record<string, unknown>;
  const plan = metadata.testPlan as
    | { groups?: { label: string }[]; assignments?: Record<string, string> }
    | undefined;
  const labels = new Set((plan?.groups ?? []).map((g) => g.label));
  const clean = zone.trim();
  if (!labels.has(clean) && clean !== "EXTRA" && clean !== "ERROR") {
    throw new Error("Unknown group.");
  }
  const variationGroup = labels.has(clean)
    ? clean
    : clean === "ERROR"
      ? "ERROR"
      : null;

  await db.$transaction(async (transaction) => {
    await transaction.sample.update({
      where: { id: sample.id },
      data: { variationGroup },
    });
    if (plan) {
      plan.assignments = { ...(plan.assignments ?? {}), [sample.code]: clean };
      await transaction.experiment.update({
        where: { id: sample.experimentId },
        data: { metadata: metadata as Prisma.InputJsonValue },
      });
    }
    await recordUserAudit(transaction, {
      actor,
      action: "sample.regroup",
      entityType: "Sample",
      entityId: sample.id,
      changes: { code: sample.code, zone: clean },
    });
  });
}
