import "server-only";
import { db } from "@/infrastructure/db/client";
import type { Actor } from "@/modules/authorization/actor";
import { isStaff } from "@/modules/authorization/policy";
import {
  freshPresetActor,
  presetRevision,
  usablePersonalPreset,
} from "./preset-access";
import type { PresetRow } from "./preset-policy";

export async function listUsablePresets(actor: Actor) {
  const fresh = await freshPresetActor(actor);
  const [published, personal] = await Promise.all([
    db.preset.findMany({
      where: { organizationId: fresh.org },
      orderBy: { usageCount: "desc" },
    }),
    db.personalPreset.findMany({
      where: { organizationId: fresh.org, ownerId: fresh.uid },
      orderBy: { usageCount: "desc" },
    }),
  ]);
  return [
    ...published.map((p) => ({ ...p, scope: "PUBLIC" as const })),
    ...personal.map(usablePersonalPreset),
  ];
}

export async function getPresetLibraryData(actor: Actor) {
  const fresh = await freshPresetActor(actor);
  const staff = isStaff(fresh);
  const [published, personal, authored, requests] = await Promise.all([
    db.preset.findMany({
      where: { organizationId: fresh.org },
      include: {
        createdBy: { select: { name: true } },
        process: { select: { name: true } },
      },
      orderBy: { name: "asc" },
    }),
    db.personalPreset.findMany({
      where: { organizationId: fresh.org, ownerId: fresh.uid },
      include: {
        owner: { select: { name: true } },
        process: { select: { name: true } },
        publicPreset: true,
        submissions: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { status: true },
        },
      },
      orderBy: { updatedAt: "desc" },
    }),
    db.presetPublicationRequest.findMany({
      where: {
        organizationId: fresh.org,
        submittedById: fresh.uid,
        status: "APPROVED",
        targetPresetId: { not: null },
      },
      select: { targetPresetId: true },
    }),
    db.presetPublicationRequest.findMany({
      where: {
        organizationId: fresh.org,
        ...(staff
          ? { status: "PENDING" as const }
          : { submittedById: fresh.uid }),
      },
      orderBy: { createdAt: staff ? "asc" : "desc" },
      take: 100,
      include: { submittedBy: { select: { name: true } } },
    }),
  ]);
  const publicRows: PresetRow[] = published.map((p) => ({
    ...p,
    scope: "PUBLIC",
    revision: presetRevision(p),
    canEdit: staff,
    canDelete: staff,
    canDraft:
      !staff &&
      (p.createdById === fresh.uid ||
        authored.some((r) => r.targetPresetId === p.id)),
    canSubmit: false,
    publicPresetId: null,
    hasUnpublishedChanges: false,
    publicationStatus: null,
  }));
  const personalRows: PresetRow[] = personal.map((p) => ({
    ...usablePersonalPreset(p),
    scope: "PERSONAL",
    revision: String(p.version),
    process: p.process,
    createdBy: p.owner,
    canEdit: true,
    canDelete: true,
    canDraft: false,
    canSubmit:
      p.submissions[0]?.status !== "PENDING" &&
      (!p.publicPreset || presetRevision(p) !== presetRevision(p.publicPreset)),
    publicPresetId: p.publicPresetId,
    hasUnpublishedChanges: Boolean(
      p.publicPreset && presetRevision(p) !== presetRevision(p.publicPreset),
    ),
    publicationStatus: p.submissions[0]?.status ?? null,
  }));
  return {
    presets: publicRows,
    personalPresets: personalRows,
    presetReviews: requests.map((r) => ({
      id: r.id,
      name: r.name,
      payload: r.payload,
      kind: r.kind,
      processId: r.processId,
      base: r.baseSnapshot,
      status: r.status,
      reason: r.reason,
      author: r.submittedBy.name,
      createdAt: r.createdAt.toISOString(),
    })),
    canReviewPresets: staff,
  };
}
