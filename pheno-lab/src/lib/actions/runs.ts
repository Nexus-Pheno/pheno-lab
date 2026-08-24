"use server";

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireSession, type Session } from "@/lib/auth";

// Capture is the one place technicians WRITE: members of an experiment (any
// role) and org admins may record executions and results.
async function assertCapture(experimentId: string): Promise<Session> {
  const session = await requireSession();
  const exp = await db.experiment.findUniqueOrThrow({
    where: { id: experimentId },
    select: { organizationId: true, createdById: true, members: { select: { userId: true } } },
  });
  if (exp.organizationId !== session.org) throw new Error("Experiment belongs to another organization.");
  if (session.role === "ADMIN") return session;
  if (exp.createdById === session.uid || exp.members.some((m) => m.userId === session.uid)) return session;
  throw new Error("You are not assigned to this experiment.");
}

export async function getOrCreateRun(experimentId: string) {
  const session = await assertCapture(experimentId);
  const existing = await db.run.findFirst({ where: { experimentId }, orderBy: { runNo: "desc" } });
  if (existing) return existing;
  return db.run.create({
    data: { experimentId, runNo: 1, status: "IN_PROGRESS", technicianId: session.uid },
  });
}

/** Multi-run: execute the same plan again — a fresh set of actuals and
 * results (e.g. a reproducibility batch), fully comparable to earlier runs. */
export async function createNewRun(experimentId: string) {
  const session = await assertCapture(experimentId);
  const last = await db.run.findFirst({ where: { experimentId }, orderBy: { runNo: "desc" } });
  return db.run.create({
    data: { experimentId, runNo: (last?.runNo ?? 0) + 1, status: "IN_PROGRESS", technicianId: session.uid },
  });
}

export async function saveExecution(
  runId: string,
  stepId: string,
  sampleId: string,
  data: {
    actuals: Record<string, string>;
    environmentConditions: Record<string, string>;
    note: string;
    flagged: boolean;
    photoFileName?: string;
  }
) {
  const run = await db.run.findUniqueOrThrow({ where: { id: runId }, select: { experimentId: true } });
  await assertCapture(run.experimentId);

  const execution = await db.stepExecution.upsert({
    where: { runId_stepId_sampleId: { runId, stepId, sampleId } },
    update: {
      actuals: data.actuals,
      environmentConditions: data.environmentConditions,
      note: data.note,
      flagged: data.flagged,
      capturedAt: new Date(),
    },
    create: {
      runId,
      stepId,
      sampleId,
      actuals: data.actuals,
      environmentConditions: data.environmentConditions,
      note: data.note,
      flagged: data.flagged,
    },
  });
  if (data.photoFileName) {
    await db.attachment.create({
      data: {
        fileName: data.photoFileName,
        storedPath: data.photoFileName,
        mime: "image/*",
        size: 0,
        stepExecutionId: execution.id,
      },
    });
  }
  return db.stepExecution.findUniqueOrThrow({
    where: { id: execution.id },
    include: { attachments: true },
  });
}

/** Batch capture: one confirmation applies the same actuals to a set of
 * samples — how processing actually happens (wash all glass together, spin
 * coat the whole batch). Characterization stays per-sample. */
export async function saveExecutionBatch(
  runId: string,
  stepId: string,
  sampleIds: string[],
  data: {
    actuals: Record<string, string>;
    environmentConditions: Record<string, string>;
    note: string;
    flagged: boolean;
    photoFileNames?: string[];
  }
) {
  const run = await db.run.findUniqueOrThrow({ where: { id: runId }, select: { experimentId: true } });
  await assertCapture(run.experimentId);

  const saved = [];
  for (const sampleId of sampleIds) {
    const execution = await db.stepExecution.upsert({
      where: { runId_stepId_sampleId: { runId, stepId, sampleId } },
      update: {
        actuals: data.actuals,
        environmentConditions: data.environmentConditions,
        note: data.note,
        flagged: data.flagged,
        capturedAt: new Date(),
      },
      create: {
        runId,
        stepId,
        sampleId,
        actuals: data.actuals,
        environmentConditions: data.environmentConditions,
        note: data.note,
        flagged: data.flagged,
      },
    });
    for (const name of data.photoFileNames ?? []) {
      await db.attachment.create({
        data: {
          fileName: name,
          storedPath: name,
          mime: "image/*",
          size: 0,
          stepExecutionId: execution.id,
        },
      });
    }
    saved.push(execution);
  }
  return db.stepExecution.findMany({
    where: { id: { in: saved.map((x) => x.id) } },
    include: { attachments: true },
  });
}

/** Remove a photo from a capture. Batch photos are attached to every sample
 * in the set, so deletion removes the same file from all executions of that
 * step in the same run. */
export async function deleteExecutionPhoto(attachmentId: string) {
  const attachment = await db.attachment.findUniqueOrThrow({
    where: { id: attachmentId },
    include: { stepExecution: { include: { run: { select: { id: true, experimentId: true } } } } },
  });
  if (!attachment.stepExecution) throw new Error("Not a capture photo.");
  await assertCapture(attachment.stepExecution.run.experimentId);
  await db.attachment.deleteMany({
    where: {
      storedPath: attachment.storedPath,
      stepExecution: {
        runId: attachment.stepExecution.runId,
        stepId: attachment.stepExecution.stepId,
      },
    },
  });
}

/** Attach freshly uploaded photos to the existing captures of a sample set. */
export async function addExecutionPhotos(
  runId: string,
  stepId: string,
  sampleIds: string[],
  fileNames: string[]
) {
  const run = await db.run.findUniqueOrThrow({ where: { id: runId }, select: { experimentId: true } });
  await assertCapture(run.experimentId);
  const executions = await db.stepExecution.findMany({
    where: { runId, stepId, sampleId: { in: sampleIds } },
  });
  for (const execution of executions) {
    for (const name of fileNames) {
      await db.attachment.create({
        data: { fileName: name, storedPath: name, mime: "image/*", size: 0, stepExecutionId: execution.id },
      });
    }
  }
  // Return the reference execution's photos (targets share the same set).
  const ref = executions[0];
  if (!ref) return [];
  const attachments = await db.attachment.findMany({ where: { stepExecutionId: ref.id }, orderBy: { createdAt: "asc" } });
  return attachments.map((a) => ({ id: a.id, path: a.storedPath }));
}

/** Undo an accidental confirm: remove the captured executions (photos
 * cascade) for a sample set on one step of a run. */
export async function clearExecutions(runId: string, stepId: string, sampleIds: string[]) {
  const run = await db.run.findUniqueOrThrow({ where: { id: runId }, select: { experimentId: true } });
  await assertCapture(run.experimentId);
  await db.stepExecution.deleteMany({ where: { runId, stepId, sampleId: { in: sampleIds } } });
}

/** Finishing lab work is part of capture: any experiment member (including
 * technicians) can mark the experiment complete from the last capture card. */
export async function completeExperiment(experimentId: string) {
  await assertCapture(experimentId);
  await db.experiment.update({ where: { id: experimentId }, data: { status: "COMPLETE" } });
}

export async function saveCharResult(
  characterizationId: string,
  sampleId: string,
  metrics: Record<string, string>,
  note: string,
  runId?: string
) {
  const char = await db.characterization.findUniqueOrThrow({
    where: { id: characterizationId },
    select: { experimentId: true },
  });
  await assertCapture(char.experimentId);

  const existing = await db.characterizationResult.findFirst({
    where: { characterizationId, sampleId, runId: runId ?? null },
  });
  if (existing) {
    return db.characterizationResult.update({
      where: { id: existing.id },
      data: { metrics: metrics as Prisma.InputJsonValue, note, capturedAt: new Date() },
    });
  }
  return db.characterizationResult.create({
    data: { characterizationId, sampleId, runId: runId ?? null, metrics: metrics as Prisma.InputJsonValue, note },
  });
}
