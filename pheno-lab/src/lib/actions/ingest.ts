"use server";

import { requireSession } from "@/lib/auth";
import {
  deleteIngestItem as deleteIngestItemService,
  findDuplicates as findDuplicatesService,
  getIngestPayload as getIngestPayloadService,
  listIngestItems as listIngestItemsService,
  markIngestDuplicate as markIngestDuplicateService,
  publishIngestItem as publishIngestItemService,
  publishIngestItems as publishIngestItemsService,
  rejectIngestItem as rejectIngestItemService,
  resolveDuplicates as resolveDuplicatesService,
  stageIngestItem as stageIngestItemService,
  updateIngestPayload as updateIngestPayloadService,
  type BulkPublishResult,
  type DuplicateAction,
  type DuplicateCandidate,
  type EnvironmentDraft,
  type EquipmentDraft,
  type ExperimentDraft,
  type FieldDiff,
  type FormulaDraft,
  type IngestKind,
  type MaterialDraft,
  type PresetDraft,
  type PublishResolution,
} from "@/modules/ingest/service";

export type {
  BulkPublishResult,
  DuplicateAction,
  DuplicateCandidate,
  EnvironmentDraft,
  EquipmentDraft,
  ExperimentDraft,
  FieldDiff,
  FormulaDraft,
  IngestKind,
  MaterialDraft,
  PresetDraft,
  PublishResolution,
};

export async function listIngestItems() {
  return listIngestItemsService(await requireSession());
}

export async function stageIngestItem(data: {
  kind: IngestKind;
  title: string;
  sourceFile?: string;
  confidence?: string;
  payload: Record<string, unknown>;
}) {
  return stageIngestItemService(await requireSession(), data);
}

export async function getIngestPayload(
  id: string,
): Promise<Record<string, unknown>> {
  return getIngestPayloadService(await requireSession(), id);
}

export async function updateIngestPayload(
  id: string,
  payload: Record<string, unknown>,
  reviewNote: string,
) {
  await updateIngestPayloadService(
    await requireSession(),
    id,
    payload,
    reviewNote,
  );
}

export async function rejectIngestItem(id: string, reviewNote: string) {
  await rejectIngestItemService(await requireSession(), id, reviewNote);
}

export async function publishIngestItem(
  id: string,
  payload: Record<string, unknown>,
  reviewNote: string,
  resolution: PublishResolution = { mode: "AUTO" },
) {
  await publishIngestItemService(
    await requireSession(),
    id,
    payload,
    reviewNote,
    resolution,
  );
}

export async function findDuplicates(
  kind: IngestKind,
  payload: Record<string, unknown>,
  selfId?: string,
): Promise<DuplicateCandidate[]> {
  return findDuplicatesService(await requireSession(), kind, payload, selfId);
}

export async function publishIngestItems(
  ids: string[],
): Promise<BulkPublishResult[]> {
  return publishIngestItemsService(await requireSession(), ids);
}

export async function resolveDuplicates(
  ids: string[],
  action: DuplicateAction,
): Promise<BulkPublishResult[]> {
  return resolveDuplicatesService(await requireSession(), ids, action);
}

export async function markIngestDuplicate(
  id: string,
  reviewNote: string,
  targetId?: string,
) {
  await markIngestDuplicateService(
    await requireSession(),
    id,
    reviewNote,
    targetId,
  );
}

export async function deleteIngestItem(id: string) {
  await deleteIngestItemService(await requireSession(), id);
}
