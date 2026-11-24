import type { Preset } from "@prisma/client";

export type UsablePreset = Preset & { scope?: "PUBLIC" | "PERSONAL" };
export type PresetRow = UsablePreset & {
  scope: "PUBLIC" | "PERSONAL";
  revision: string;
  process: { name: string };
  createdBy: { name: string } | null;
  canEdit: boolean;
  canDelete: boolean;
  canDraft: boolean;
  canSubmit: boolean;
  publicPresetId: string | null;
  hasUnpublishedChanges: boolean;
  publicationStatus: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED" | null;
};

export type PresetErrorCode =
  | "forbidden"
  | "not_found"
  | "stale"
  | "not_pending"
  | "no_changes"
  | "invalid";
export class PresetOperationError extends Error {
  constructor(readonly code: PresetErrorCode) {
    super(`Preset operation: ${code}`);
  }
}

export const personalPresetRef = (id: string) => `personal:${id}`;
export function parsePresetRef(ref: string) {
  return ref.startsWith("personal:")
    ? { personal: true, id: ref.slice(9) }
    : { personal: false, id: ref };
}

export type PresetReviewRow = {
  id: string;
  name: string;
  payload: unknown;
  kind: "STEP" | "CHARACTERIZATION";
  processId: string;
  base: unknown;
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
  reason: string;
  author: string;
  createdAt: string;
};
