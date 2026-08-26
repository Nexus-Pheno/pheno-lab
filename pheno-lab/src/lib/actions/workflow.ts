"use server";

import { queueTranslations } from "@/modules/translations/service";
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth";
import {
  approveExperiment as approveExperimentService,
  assignExperiment as assignExperimentService,
  requestChanges as requestChangesService,
  startLabWork as startLabWorkService,
  submitForReview as submitForReviewService,
} from "@/modules/workflow/service";

const refresh = () => revalidatePath("/");

export async function assignExperiment(id: string, userId: string | null) {
  await assignExperimentService(await requireSession(), {
    experimentId: id,
    userId,
  });
  refresh();
}

export async function startLabWork(id: string) {
  await startLabWorkService(await requireSession(), id);
  refresh();
}

export async function submitForReview(id: string, note: string) {
  const session = await requireSession();
  await submitForReviewService(session, id, note);
  queueTranslations(session, [note]);
  refresh();
}

export async function approveExperiment(id: string, reviewNote: string) {
  await approveExperimentService(await requireSession(), id, reviewNote);
  refresh();
}

export async function requestChanges(id: string, reviewNote: string) {
  await requestChangesService(await requireSession(), id, reviewNote);
  refresh();
}
