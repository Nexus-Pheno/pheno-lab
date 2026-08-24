"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth";
import {
  buildDataCsv as buildDataCsvService,
  decideExportRequest as decideExportRequestService,
  listExportRequests as listExportRequestsService,
  pendingExportCount as pendingExportCountService,
  requestExport as requestExportService,
  type ExportDecision,
  type ExportRow,
} from "@/modules/exports/service";

export type { ExportDecision, ExportRow };

export async function requestExport(input: {
  scope: string;
  detail: string;
  rowCount: number;
  reason: string;
}): Promise<ExportDecision> {
  const decision = await requestExportService(await requireSession(), input);
  revalidatePath("/exports");
  return decision;
}

export async function listExportRequests(): Promise<ExportRow[]> {
  return listExportRequestsService(await requireSession());
}

export async function decideExportRequest(
  id: string,
  approve: boolean,
  note: string,
) {
  await decideExportRequestService(await requireSession(), {
    id,
    approve,
    note,
  });
  revalidatePath("/exports");
}

export async function pendingExportCount(): Promise<number> {
  return pendingExportCountService(await requireSession());
}

export async function buildDataCsv(query: string) {
  return buildDataCsvService(await requireSession(), query);
}
