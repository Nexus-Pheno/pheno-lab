import "server-only";

import { Prisma } from "@prisma/client";
import { db } from "@/infrastructure/db/client";
import { objectStorage } from "@/infrastructure/storage";
import { captureFieldKind } from "@/lib/capture-fields";
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
      select: { experimentId: true, status: true },
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
    run.status === "CANCELLED" ||
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

type ResolvedMaterialSelection = {
  parameterName: string;
  materialId: string;
};

async function resolveMaterialSelections(
  actor: Actor,
  input: ExecutionBatchInput,
): Promise<ResolvedMaterialSelection[]> {
  const stepParameters = await db.stepParameter.findMany({
    where: { stepId: input.stepId },
    select: { name: true, unit: true, source: true },
  });
  const materialParameters = stepParameters.filter(
    (parameter) => captureFieldKind(parameter) === "material",
  );
  const materialParameterNames = new Set(
    materialParameters.map((parameter) => parameter.name),
  );
  const entries = Object.entries(input.data.materialSelections);

  if (entries.some(([name]) => !materialParameterNames.has(name))) {
    throw new Error("A material selection does not belong to this step.");
  }
  for (const parameter of materialParameters) {
    const actual = input.data.actuals[parameter.name]?.trim() ?? "";
    if (actual && !input.data.materialSelections[parameter.name]) {
      throw new Error(
        `Material actual “${parameter.name}” must select a material card.`,
      );
    }
  }
  if (entries.length === 0) return [];

  const ids = [...new Set(entries.map(([, materialId]) => materialId))];
  const materials = await db.material.findMany({
    where: {
      id: { in: ids },
      organizationId: actor.org,
      archived: false,
    },
    select: { id: true, name: true },
  });
  if (materials.length !== ids.length) {
    throw new Error("A selected material card is unavailable.");
  }
  const byId = new Map(materials.map((material) => [material.id, material]));
  return entries.map(([parameterName, materialId]) => {
    const material = byId.get(materialId)!;
    if (input.data.actuals[parameterName]?.trim() !== material.name) {
      throw new Error(
        `Material actual “${parameterName}” does not match its material card.`,
      );
    }
    return { parameterName, materialId };
  });
}

export async function getOrCreateRunService(
  actor: Actor,
  experimentId: string,
) {
  await requireExperimentPermission(actor, experimentId, "capture");
  const existing = await db.run.findFirst({
    where: { experimentId, status: { not: "CANCELLED" } },
    orderBy: { runNo: "desc" },
  });
  if (existing) return existing;
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

/**
 * Remove a run from active capture without destroying its research records.
 * The existing CANCELLED state is the soft-delete boundary: active queries
 * omit it, while executions, results, measurements, and attachment references
 * remain available for audit/recovery. At least one active run must remain.
 */
export async function cancelRunService(actor: Actor, runId: string) {
  const run = await db.run.findUniqueOrThrow({
    where: { id: runId },
    select: { experimentId: true },
  });
  await requireExperimentPermission(actor, run.experimentId, "capture");

  return db.$transaction(
    async (transaction) => {
      const target = await transaction.run.findUniqueOrThrow({
        where: { id: runId },
        select: {
          id: true,
          experimentId: true,
          runNo: true,
          status: true,
          _count: {
            select: {
              executions: true,
              results: true,
              jvMeasurements: true,
            },
          },
        },
      });
      if (target.status === "CANCELLED") {
        throw new Error("Run is already cancelled.");
      }

      const activeRuns = await transaction.run.findMany({
        where: {
          experimentId: target.experimentId,
          status: { not: "CANCELLED" },
        },
        orderBy: { runNo: "asc" },
        select: { id: true, runNo: true },
      });
      if (activeRuns.length <= 1) {
        throw new Error("At least one active run must remain.");
      }

      const nextRun = activeRuns.filter((row) => row.id !== target.id).at(-1);
      if (!nextRun) throw new Error("No active run remains.");

      await transaction.run.update({
        where: { id: target.id },
        data: { status: "CANCELLED" },
      });
      await recordUserAudit(transaction, {
        actor,
        action: "run.cancel",
        entityType: "Run",
        entityId: target.id,
        metadata: {
          experimentId: target.experimentId,
          runNo: target.runNo,
          executionsPreserved: target._count.executions,
          resultsPreserved: target._count.results,
          measurementsPreserved: target._count.jvMeasurements,
        },
      });
      return { nextRunId: nextRun.id };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

export async function saveExecutionBatchService(
  actor: Actor,
  input: ExecutionBatchInput,
) {
  const experimentId = await requireCaptureGraph(actor, input);
  const photos = input.data.photoFileNames ?? [];
  const materialSelections = await resolveMaterialSelections(actor, input);
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
      await transaction.executionMaterial.deleteMany({
        where: { executionId: execution.id },
      });
      if (materialSelections.length > 0) {
        await transaction.executionMaterial.createMany({
          data: materialSelections.map((selection) => ({
            executionId: execution.id,
            ...selection,
          })),
        });
      }
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
        materialSelectionCount: materialSelections.length,
      },
    });
    return ids;
  });

  return db.stepExecution.findMany({
    where: { id: { in: executionIds } },
    include: { attachments: true, materialSelections: true },
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
          select: { experimentId: true, status: true },
        })
      : Promise.resolve(null),
  ]);
  if (
    sample.experimentId !== characterization.experimentId ||
    (run &&
      (run.status === "CANCELLED" ||
        run.experimentId !== characterization.experimentId))
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
  note?: string,
) {
  const sample = await db.sample.findUniqueOrThrow({
    where: { id: sampleId },
    select: { id: true, code: true, experimentId: true, note: true },
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
    const trashNote = clean === "ERROR" && note?.trim() ? note.trim() : "";
    await transaction.sample.update({
      where: { id: sample.id },
      data: {
        variationGroup,
        ...(trashNote
          ? {
              note: sample.note
                ? `${sample.note}\n[trash] ${trashNote}`
                : `[trash] ${trashNote}`,
            }
          : {}),
      },
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
      changes: {
        code: sample.code,
        zone: clean,
        ...(note?.trim() ? { note: note.trim() } : {}),
      },
    });
  });
}
