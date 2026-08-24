"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth";
import type { RematchSummary } from "@/modules/instruments/measurement-rematch-service";
import {
  assignMeasurement as assignMeasurementService,
  explainSerial as explainSerialService,
  pullJvFiles as pullJvFilesService,
  rematchNow as rematchNowService,
  setSampleAliases as setSampleAliasesService,
  unassignMeasurement as unassignMeasurementService,
  type JvFileRow,
  type JvPullResult,
} from "@/modules/instruments/measurement-service";

export type { JvFileRow, JvPullResult };

export async function pullJvFiles(experimentId: string): Promise<JvPullResult> {
  return pullJvFilesService(await requireSession(), experimentId);
}

export async function assignMeasurement(
  measurementId: string,
  sampleId: string,
): Promise<void> {
  const experimentId = await assignMeasurementService(await requireSession(), {
    measurementId,
    sampleId,
  });
  revalidatePath(`/experiments/${experimentId}`);
}

export async function unassignMeasurement(
  measurementId: string,
  ignore = false,
): Promise<void> {
  const experimentId = await unassignMeasurementService(
    await requireSession(),
    {
      measurementId,
      ignore,
    },
  );
  revalidatePath("/instruments");
  if (experimentId) revalidatePath(`/experiments/${experimentId}`);
}

export async function rematchNow(): Promise<RematchSummary> {
  const summary = await rematchNowService(await requireSession());
  revalidatePath("/instruments");
  return summary;
}

export async function explainSerial(serial: string): Promise<string> {
  return explainSerialService(await requireSession(), serial);
}

export async function setSampleAliases(
  sampleId: string,
  aliases: string[],
): Promise<string[]> {
  const result = await setSampleAliasesService(await requireSession(), {
    sampleId,
    aliases,
  });
  revalidatePath(`/experiments/${result.experimentId}`);
  return result.aliases;
}
