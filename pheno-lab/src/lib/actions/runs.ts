"use server";

import { setJvMetricPolicy } from "@/modules/instruments/matching-service";
import { requireSession } from "@/lib/auth";
import {
  captureTargetSchema,
  characterizationResultSchema,
  entityIdSchema,
  executionBatchSchema,
  executionPhotosSchema,
} from "@/modules/runs/schema";
import {
  addExecutionPhotosService,
  clearExecutionsService,
  completeExperimentService,
  createNewRunService,
  deleteExecutionPhotoService,
  getOrCreateRunService,
  saveCharacterizationResultService,
  saveExecutionBatchService,
  regroupSampleService,
} from "@/modules/runs/service";

export async function getOrCreateRun(experimentId: string) {
  const actor = await requireSession();
  return getOrCreateRunService(actor, entityIdSchema.parse(experimentId));
}

export async function createNewRun(experimentId: string) {
  const actor = await requireSession();
  return createNewRunService(actor, entityIdSchema.parse(experimentId));
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
  },
) {
  const actor = await requireSession();
  const parsed = executionBatchSchema.parse({
    runId,
    stepId,
    sampleIds: [sampleId],
    data: {
      ...data,
      photoFileNames: data.photoFileName ? [data.photoFileName] : undefined,
    },
  });
  const [saved] = await saveExecutionBatchService(actor, parsed);
  if (!saved) throw new Error("Execution was not saved.");
  return saved;
}

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
  },
) {
  const actor = await requireSession();
  return saveExecutionBatchService(
    actor,
    executionBatchSchema.parse({ runId, stepId, sampleIds, data }),
  );
}

export async function deleteExecutionPhoto(attachmentId: string) {
  const actor = await requireSession();
  return deleteExecutionPhotoService(actor, entityIdSchema.parse(attachmentId));
}

export async function addExecutionPhotos(
  runId: string,
  stepId: string,
  sampleIds: string[],
  fileNames: string[],
) {
  const actor = await requireSession();
  return addExecutionPhotosService(
    actor,
    executionPhotosSchema.parse({ runId, stepId, sampleIds, fileNames }),
  );
}

export async function clearExecutions(
  runId: string,
  stepId: string,
  sampleIds: string[],
) {
  const actor = await requireSession();
  return clearExecutionsService(
    actor,
    captureTargetSchema.parse({ runId, stepId, sampleIds }),
  );
}

export async function completeExperiment(experimentId: string) {
  const actor = await requireSession();
  return completeExperimentService(actor, entityIdSchema.parse(experimentId));
}

export async function saveCharResult(
  characterizationId: string,
  sampleId: string,
  metrics: Record<string, string>,
  note: string,
  runId?: string,
) {
  const actor = await requireSession();
  return saveCharacterizationResultService(
    actor,
    characterizationResultSchema.parse({
      characterizationId,
      sampleId,
      metrics,
      note,
      runId,
    }),
  );
}

export async function setJvDisplayPolicy(resultId: string, policy: string) {
  const actor = await requireSession();
  return setJvMetricPolicy(actor, String(resultId), String(policy));
}

export async function regroupSample(sampleId: string, zone: string, note?: string) {
  const actor = await requireSession();
  return regroupSampleService(
    actor,
    String(sampleId),
    String(zone),
    note === undefined ? undefined : String(note),
  );
}
