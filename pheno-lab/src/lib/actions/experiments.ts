"use server";

import type { ExperimentStatus, Prisma } from "@prisma/client";
import { queueTranslations } from "@/modules/translations/service";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireSession, type Session } from "@/lib/auth";
import type { TestPlan } from "@/lib/library";
import type {
  CharDraft,
  CharPresetPayload,
  StepDraft,
  StepPresetPayload,
} from "@/lib/types";
import { experimentVisibilityScope } from "@/modules/authorization/scope";
import {
  addCharacterization as addCharacterizationService,
  addMember as addMemberService,
  addStep as addStepService,
  applyTestPlan as applyTestPlanService,
  clearTestData as clearTestDataService,
  createExperiment as createExperimentService,
  generateAiSummary as generateAiSummaryService,
  deleteCharacterization as deleteCharacterizationService,
  deleteExperiment as deleteExperimentService,
  deletePreset as deletePresetService,
  deleteStep as deleteStepService,
  duplicateExperiment as duplicateExperimentService,
  listTestExperiments as listTestExperimentsService,
  quickCreateMaterial as quickCreateMaterialService,
  removeMember as removeMemberService,
  reorderSteps as reorderStepsService,
  saveCharacterization as saveCharacterizationService,
  saveCharPreset as saveCharPresetService,
  saveStep as saveStepService,
  saveStepPreset as saveStepPresetService,
  setExperimentTestMode as setExperimentTestModeService,
  setSamples as setSamplesService,
  updateExperimentMeta as updateExperimentMetaService,
  updatePreset as updatePresetService,
} from "@/modules/experiments/service";

export async function canViewWhere(
  _session?: Session,
  includeTest = false,
): Promise<Prisma.ExperimentWhereInput> {
  return experimentVisibilityScope(
    await requireSession(),
    z.boolean().parse(includeTest),
  );
}

export async function createExperiment(isTest = false) {
  const experiment = await createExperimentService(
    await requireSession(),
    z.boolean().parse(isTest),
  );
  revalidatePath("/");
  redirect(`/experiments/${experiment.id}`);
}

export async function updateExperimentMeta(
  id: string,
  data: Partial<{
    title: string;
    campaign: string;
    observation: string;
    problem: string;
    hypothesis: string;
    conclusion: string;
    status: ExperimentStatus;
  }>,
) {
  const session = await requireSession();
  await updateExperimentMetaService(session, id, data);
  queueTranslations(session, [
    data.observation,
    data.problem,
    data.hypothesis,
    data.conclusion,
  ]);
  revalidatePath("/");
}

export async function deleteExperiment(id: string) {
  await deleteExperimentService(await requireSession(), id);
  revalidatePath("/");
}

export async function duplicateExperiment(id: string) {
  const row = await duplicateExperimentService(await requireSession(), id);
  revalidatePath("/");
  return row;
}

export async function addMember(experimentId: string, userId: string) {
  return addMemberService(await requireSession(), experimentId, userId);
}

export async function removeMember(experimentId: string, userId: string) {
  return removeMemberService(await requireSession(), experimentId, userId);
}

export async function setSamples(
  experimentId: string,
  samples: { code: string; variationGroup: string | null }[],
) {
  return setSamplesService(await requireSession(), experimentId, samples);
}

export async function addStep(experimentId: string, processId: string) {
  return addStepService(await requireSession(), experimentId, processId);
}

export async function saveStep(
  stepId: string,
  draft: StepDraft,
  appliedPresetId?: string | null,
) {
  return saveStepService(
    await requireSession(),
    stepId,
    draft,
    appliedPresetId,
  );
}

export async function deleteStep(stepId: string) {
  await deleteStepService(await requireSession(), stepId);
}

export async function reorderSteps(experimentId: string, orderedIds: string[]) {
  await reorderStepsService(await requireSession(), experimentId, orderedIds);
}

export async function addCharacterization(
  experimentId: string,
  processId: string,
) {
  return addCharacterizationService(
    await requireSession(),
    experimentId,
    processId,
  );
}

export async function saveCharacterization(
  id: string,
  draft: CharDraft,
  appliedPresetId?: string | null,
) {
  return saveCharacterizationService(
    await requireSession(),
    id,
    draft,
    appliedPresetId,
  );
}

export async function deleteCharacterization(id: string) {
  await deleteCharacterizationService(await requireSession(), id);
}

export async function saveStepPreset(
  name: string,
  processId: string,
  payload: StepPresetPayload,
) {
  return saveStepPresetService(
    await requireSession(),
    name,
    processId,
    payload,
  );
}

export async function saveCharPreset(
  name: string,
  processId: string,
  payload: CharPresetPayload,
) {
  return saveCharPresetService(
    await requireSession(),
    name,
    processId,
    payload,
  );
}

export async function deletePreset(id: string) {
  await deletePresetService(await requireSession(), id);
  revalidatePath("/library");
}

export async function quickCreateMaterial(
  name: string,
  processId: string | null,
) {
  return quickCreateMaterialService(await requireSession(), name, processId);
}

export async function generateAiSummary(experimentId: string, lang: "en" | "zh") {
  return generateAiSummaryService(
    await requireSession(),
    experimentId,
    z.enum(["en", "zh"]).parse(lang),
  );
}

export async function applyTestPlan(experimentId: string, plan: TestPlan) {
  return applyTestPlanService(await requireSession(), experimentId, plan);
}

export async function updatePreset(
  id: string,
  data: { name?: string; payload?: StepPresetPayload | CharPresetPayload },
) {
  await updatePresetService(await requireSession(), id, data);
  revalidatePath("/library");
}

export async function listTestExperiments() {
  return listTestExperimentsService(await requireSession());
}

export async function setExperimentTestMode(id: string, isTest: boolean) {
  await setExperimentTestModeService(
    await requireSession(),
    id,
    z.boolean().parse(isTest),
  );
  revalidatePath("/");
  revalidatePath("/test-data");
}

export async function clearTestData(): Promise<number> {
  const count = await clearTestDataService(await requireSession());
  revalidatePath("/");
  revalidatePath("/test-data");
  return count;
}
