import "server-only";
import { lockMaterialCatalogue } from "@/infrastructure/db/material-lock";
import { publicMaterialSelect } from "@/modules/library/material-visibility";

import { Prisma } from "@prisma/client";
import { db } from "@/infrastructure/db/client";
import type { Actor } from "@/modules/authorization/actor";
import { assertAdmin, isStaff } from "@/modules/authorization/policy";
import { recordUserAudit } from "@/modules/audit/writer";
import { lockPresetCatalogue } from "@/infrastructure/db/preset-lock";
import {
  freshPresetActor,
  presetRevision,
  presetSnapshot,
  usablePersonalPreset,
} from "./preset-access";
import { parsePresetRef, PresetOperationError } from "./preset-policy";
import { notify } from "@/modules/notifications/service";
import { z } from "zod";
import { assertEdit } from "./access";
import { assertPresetReferences } from "./plan-service";
import {
  charPresetPayloadSchema,
  experimentIdSchema,
  presetNameSchema,
  presetUpdateSchema,
  stepPresetPayloadSchema,
} from "./schema";

// ---- Presets ----

const revisionSchema = z.string().min(1).max(100);
const parsePayload = (kind: "STEP" | "CHARACTERIZATION", raw: unknown) =>
  kind === "STEP"
    ? stepPresetPayloadSchema.parse(raw)
    : charPresetPayloadSchema.parse(raw);

async function createPreset(
  actor: Actor,
  kind: "STEP" | "CHARACTERIZATION",
  rawName: unknown,
  rawProcessId: unknown,
  rawPayload: unknown,
) {
  const name = presetNameSchema.parse(rawName);
  const processId = experimentIdSchema.parse(rawProcessId);
  const payload = parsePayload(kind, rawPayload);
  return db.$transaction(async (tx) => {
    await lockPresetCatalogue(tx, actor.org);
    const fresh = await freshPresetActor(actor, tx);
    await assertPresetReferences(tx, fresh, processId, payload);
    const data = {
      organizationId: fresh.org,
      kind,
      processId,
      name,
      payload: payload as Prisma.InputJsonValue,
    };
    const row = isStaff(fresh)
      ? {
          ...(await tx.preset.create({
            data: { ...data, createdById: fresh.uid },
          })),
          scope: "PUBLIC" as const,
        }
      : usablePersonalPreset(
          await tx.personalPreset.create({
            data: { ...data, ownerId: fresh.uid },
          }),
        );
    await recordUserAudit(tx, {
      actor: fresh,
      action: "library.preset.created",
      entityType: isStaff(fresh) ? "Preset" : "PersonalPreset",
      entityId: parsePresetRef(row.id).id,
      metadata: {
        kind,
        processId,
        scope: isStaff(fresh) ? "PUBLIC" : "PERSONAL",
      },
    });
    return row;
  });
}
export async function saveStepPreset(
  actor: Actor,
  name: unknown,
  processId: string,
  payload: unknown,
) {
  return createPreset(actor, "STEP", name, processId, payload);
}
export async function saveCharPreset(
  actor: Actor,
  name: unknown,
  processId: string,
  payload: unknown,
) {
  return createPreset(actor, "CHARACTERIZATION", name, processId, payload);
}

export async function deletePreset(
  actor: Actor,
  rawId: unknown,
  rawRevision: unknown,
) {
  const ref = parsePresetRef(experimentIdSchema.parse(rawId));
  const revision = revisionSchema.parse(rawRevision);
  await db.$transaction(async (tx) => {
    await lockPresetCatalogue(tx, actor.org);
    const fresh = await freshPresetActor(actor, tx);
    if (ref.personal) {
      const row = await tx.personalPreset.findFirst({
        where: { id: ref.id, organizationId: fresh.org, ownerId: fresh.uid },
      });
      if (!row) throw new PresetOperationError("not_found");
      if (String(row.version) !== revision)
        throw new PresetOperationError("stale");
      await tx.presetPublicationRequest.updateMany({
        where: { personalPresetId: row.id, status: "PENDING" },
        data: { status: "CANCELLED", resolvedAt: new Date() },
      });
      await tx.personalPreset.delete({ where: { id: row.id } });
    } else {
      if (!isStaff(fresh)) throw new PresetOperationError("forbidden");
      await tx.$queryRaw`SELECT id FROM "Preset" WHERE id = ${ref.id} AND "organizationId" = ${fresh.org} FOR UPDATE`;
      const row = await tx.preset.findFirst({
        where: { id: ref.id, organizationId: fresh.org },
      });
      if (!row) throw new PresetOperationError("not_found");
      if (presetRevision(row) !== revision)
        throw new PresetOperationError("stale");
      await tx.presetPublicationRequest.updateMany({
        where: {
          organizationId: fresh.org,
          targetPresetId: row.id,
          status: "PENDING",
        },
        data: { status: "CANCELLED", resolvedAt: new Date() },
      });
      await tx.preset.delete({ where: { id: row.id } });
    }
    await recordUserAudit(tx, {
      actor: fresh,
      action: "library.preset.deleted",
      entityType: ref.personal ? "PersonalPreset" : "Preset",
      entityId: ref.id,
    });
  });
}

// ---- Quick-create from the designer ----

export async function quickCreateMaterial(
  actor: Actor,
  rawName: unknown,
  processId: string | null,
) {
  await db.user.findFirstOrThrow({
    where: { id: actor.uid, organizationId: actor.org, active: true },
  });
  const name = presetNameSchema.parse(rawName);
  if (processId) processId = experimentIdSchema.parse(processId);
  return db.$transaction(async (tx) => {
    await lockMaterialCatalogue(tx, actor.org);
    if (processId) {
      const process = await tx.process.count({
        where: { id: processId, organizationId: actor.org },
      });
      if (!process) throw new Error("Process belongs to another organization.");
    }
    const row = await tx.material.create({
      select: publicMaterialSelect,
      data: { organizationId: actor.org, name, processId },
    });
    await recordUserAudit(tx, {
      actor,
      action: "library.material.created",
      entityType: "Material",
      entityId: row.id,
      changes: { name, processId },
    });
    return row;
  });
}

// ---- Preset editing ----
//
// Staff edit the public configuration directly; personal copies always stay owner-only.

export async function updatePreset(
  actor: Actor,
  rawId: unknown,
  rawData: unknown,
  rawRevision: unknown,
) {
  const ref = parsePresetRef(experimentIdSchema.parse(rawId));
  const data = presetUpdateSchema.parse(rawData);
  const revision = revisionSchema.parse(rawRevision);
  await db.$transaction(async (tx) => {
    await lockPresetCatalogue(tx, actor.org);
    const fresh = await freshPresetActor(actor, tx);
    if (!ref.personal)
      await tx.$queryRaw`SELECT id FROM "Preset" WHERE id = ${ref.id} AND "organizationId" = ${fresh.org} FOR UPDATE`;
    const row = ref.personal
      ? await tx.personalPreset.findFirst({
          where: { id: ref.id, organizationId: fresh.org, ownerId: fresh.uid },
        })
      : await tx.preset.findFirst({
          where: { id: ref.id, organizationId: fresh.org },
        });
    if (!row) throw new PresetOperationError("not_found");
    if (!ref.personal && !isStaff(fresh))
      throw new PresetOperationError("forbidden");
    const current = ref.personal
      ? String((row as { version: number }).version)
      : presetRevision(row);
    if (current !== revision) throw new PresetOperationError("stale");
    const payload = data.payload
      ? parsePayload(row.kind, data.payload)
      : undefined;
    if (payload)
      await assertPresetReferences(tx, fresh, row.processId, payload);
    const changes = {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(payload ? { payload: payload as Prisma.InputJsonValue } : {}),
    };
    if (ref.personal) {
      await tx.personalPreset.update({
        where: { id: row.id },
        data: { ...changes, version: { increment: 1 } },
      });
      await tx.presetPublicationRequest.updateMany({
        where: { personalPresetId: row.id, status: "PENDING" },
        data: { status: "CANCELLED", resolvedAt: new Date() },
      });
    } else await tx.preset.update({ where: { id: row.id }, data: changes });
    await recordUserAudit(tx, {
      actor: fresh,
      action: "library.preset.updated",
      entityType: ref.personal ? "PersonalPreset" : "Preset",
      entityId: row.id,
      changes: {
        nameUpdated: data.name !== undefined,
        payloadUpdated: Boolean(payload),
      },
    });
  });
}

export async function startPresetDraft(actor: Actor, rawId: unknown) {
  const id = experimentIdSchema.parse(rawId);
  return db.$transaction(async (tx) => {
    await lockPresetCatalogue(tx, actor.org);
    const fresh = await freshPresetActor(actor, tx);
    const published = await tx.preset.findFirst({
      where: { id, organizationId: fresh.org },
    });
    if (!published) throw new PresetOperationError("not_found");
    const authored =
      published.createdById === fresh.uid ||
      (await tx.presetPublicationRequest.count({
        where: {
          organizationId: fresh.org,
          targetPresetId: id,
          status: "APPROVED",
          submittedById: fresh.uid,
        },
      })) > 0;
    if (!authored) throw new PresetOperationError("forbidden");
    const existing = await tx.personalPreset.findFirst({
      where: { ownerId: fresh.uid, publicPresetId: id },
    });
    if (existing) return usablePersonalPreset(existing);
    const row = await tx.personalPreset.create({
      data: {
        organizationId: fresh.org,
        ownerId: fresh.uid,
        publicPresetId: id,
        kind: published.kind,
        processId: published.processId,
        name: published.name,
        payload: published.payload as Prisma.InputJsonValue,
      },
    });
    await recordUserAudit(tx, {
      actor: fresh,
      action: "library.preset.draft_created",
      entityType: "PersonalPreset",
      entityId: row.id,
      metadata: { publicPresetId: id },
    });
    return usablePersonalPreset(row);
  });
}

async function presetNotice(
  tx: Prisma.TransactionClient,
  actor: Actor & { name: string },
  kind:
    | "preset_review_requested"
    | "preset_review_approved"
    | "preset_review_rejected",
  label: string,
  ownerId?: string,
) {
  const recipients = await tx.user.findMany({
    where: {
      organizationId: actor.org,
      active: true,
      pendingApproval: false,
      testingOnly: false,
      mustChangePassword: false,
      ...(ownerId ? { id: ownerId } : { role: { in: ["ADMIN", "MANAGER"] } }),
    },
    select: { id: true },
  });
  for (const user of recipients)
    await notify(tx, {
      organizationId: actor.org,
      userId: user.id,
      actorUserId: actor.uid,
      kind,
      actorName: actor.name,
      entityLabel: label,
      href: "/library#presets",
    });
}

export async function submitPresetForReview(
  actor: Actor,
  rawId: unknown,
  rawRevision: unknown,
) {
  const ref = parsePresetRef(experimentIdSchema.parse(rawId));
  const revision = revisionSchema.parse(rawRevision);
  if (!ref.personal) throw new PresetOperationError("forbidden");
  return db.$transaction(async (tx) => {
    await lockPresetCatalogue(tx, actor.org);
    const fresh = await freshPresetActor(actor, tx);
    const row = await tx.personalPreset.findFirst({
      where: { id: ref.id, organizationId: fresh.org, ownerId: fresh.uid },
    });
    if (!row) throw new PresetOperationError("not_found");
    if (String(row.version) !== revision)
      throw new PresetOperationError("stale");
    const pending = await tx.presetPublicationRequest.findFirst({
      where: { personalPresetId: row.id, status: "PENDING" },
    });
    if (pending) return { id: pending.id };
    const published = row.publicPresetId
      ? await tx.preset.findFirst({
          where: { id: row.publicPresetId, organizationId: fresh.org },
        })
      : null;
    if (published && presetRevision(row) === presetRevision(published))
      throw new PresetOperationError("no_changes");
    const payload = parsePayload(row.kind, row.payload);
    await assertPresetReferences(tx, fresh, row.processId, payload);
    const updated = await tx.personalPreset.update({
      where: { id: row.id },
      data: { version: { increment: 1 } },
    });
    const request = await tx.presetPublicationRequest.create({
      data: {
        organizationId: fresh.org,
        personalPresetId: row.id,
        submittedById: fresh.uid,
        sourceVersion: updated.version,
        name: row.name,
        payload: payload as Prisma.InputJsonValue,
        kind: row.kind,
        processId: row.processId,
        targetPresetId: row.publicPresetId,
        baseSnapshot: published
          ? (presetSnapshot(published) as Prisma.InputJsonValue)
          : Prisma.DbNull,
      },
    });
    await recordUserAudit(tx, {
      actor: fresh,
      action: "library.preset.publication_requested",
      entityType: "PresetPublicationRequest",
      entityId: request.id,
      metadata: {
        personalPresetId: row.id,
        targetPresetId: row.publicPresetId,
      },
    });
    await presetNotice(tx, fresh, "preset_review_requested", row.name);
    return { id: request.id };
  });
}

export async function reviewPresetPublication(actor: Actor, raw: unknown) {
  const { id, decision, reason } = z
    .object({
      id: experimentIdSchema,
      decision: z.enum(["APPROVED", "REJECTED"]),
      reason: z.string().trim().max(2000).default(""),
    })
    .parse(raw);
  if (decision === "REJECTED" && !reason)
    throw new PresetOperationError("invalid");
  await db.$transaction(async (tx) => {
    await lockPresetCatalogue(tx, actor.org);
    const fresh = await freshPresetActor(actor, tx);
    if (!isStaff(fresh)) throw new PresetOperationError("forbidden");
    const request = await tx.presetPublicationRequest.findFirst({
      where: { id, organizationId: fresh.org, status: "PENDING" },
    });
    if (!request || !request.personalPresetId)
      throw new PresetOperationError("not_pending");
    const personal = await tx.personalPreset.findFirst({
      where: {
        id: request.personalPresetId,
        organizationId: fresh.org,
        ownerId: request.submittedById,
      },
    });
    if (
      !personal ||
      personal.version !== request.sourceVersion ||
      personal.publicPresetId !== request.targetPresetId
    )
      throw new PresetOperationError("stale");
    let targetPresetId = request.targetPresetId;
    if (decision === "APPROVED") {
      const payload = parsePayload(request.kind, request.payload);
      await assertPresetReferences(tx, fresh, request.processId, payload);
      let published;
      if (request.targetPresetId) {
        await tx.$queryRaw`SELECT id FROM "Preset" WHERE id = ${request.targetPresetId} AND "organizationId" = ${fresh.org} FOR UPDATE`;
        const current = await tx.preset.findFirst({
          where: { id: request.targetPresetId, organizationId: fresh.org },
        });
        if (
          !current ||
          presetRevision(current) !==
            presetRevision(request.baseSnapshot as unknown as typeof current)
        )
          throw new PresetOperationError("stale");
        published = await tx.preset.update({
          where: { id: current.id },
          data: {
            name: request.name,
            payload: payload as Prisma.InputJsonValue,
          },
        });
      } else {
        published = await tx.preset.create({
          data: {
            organizationId: fresh.org,
            kind: request.kind,
            processId: request.processId,
            name: request.name,
            payload: payload as Prisma.InputJsonValue,
            createdById: fresh.uid,
          },
        });
      }
      await tx.personalPreset.update({
        where: { id: personal.id },
        data: { publicPresetId: published.id, version: { increment: 1 } },
      });
      targetPresetId = published.id;
      await tx.presetPublicationRequest.update({
        where: { id: request.id },
        data: { targetPresetId: published.id },
      });
    }
    await tx.presetPublicationRequest.update({
      where: { id: request.id },
      data: {
        status: decision,
        reason,
        reviewedById: fresh.uid,
        resolvedAt: new Date(),
      },
    });
    await recordUserAudit(tx, {
      actor: fresh,
      action:
        decision === "APPROVED"
          ? "library.preset.publication_approved"
          : "library.preset.publication_rejected",
      entityType: "PresetPublicationRequest",
      entityId: request.id,
      metadata: {
        personalPresetId: personal.id,
        targetPresetId,
      },
    });
    await presetNotice(
      tx,
      fresh,
      decision === "APPROVED"
        ? "preset_review_approved"
        : "preset_review_rejected",
      request.name,
      request.submittedById,
    );
  });
}

// ---- Test data ----
//
// Test runs are real rows carrying `isTest`, not a second database: the
// library they reference (materials, equipment, recipes) is shared, and a
// separate database would have to duplicate all of it or break those links.
// The flag gives the same practical result — test work never appears in a
// real view, and it can be cleared in one action.

/** Test experiments, for the Test data view. */
export async function listTestExperiments(actor: Actor) {
  return db.experiment.findMany({
    where: { organizationId: actor.org, isTest: true, deletedAt: null },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      code: true,
      title: true,
      status: true,
      createdAt: true,
      createdBy: { select: { name: true } },
      _count: { select: { samples: true, steps: true, runs: true } },
    },
  });
}

/** Move an experiment between the test and real spaces. */
export async function setExperimentTestMode(
  actor: Actor,
  rawId: unknown,
  isTest: boolean,
) {
  const id = experimentIdSchema.parse(rawId);
  await assertEdit(actor, id);
  await db.$transaction(async (tx) => {
    await tx.experiment.update({
      where: { id },
      data: { isTest, ...(isTest ? { templatePinnedAt: null } : {}) },
    });
    await recordUserAudit(tx, {
      actor,
      action: "experiment.test-mode.updated",
      entityType: "Experiment",
      entityId: id,
      changes: { isTest },
    });
  });
}

/**
 * Delete every test experiment in the organization.
 *
 * Admin-only and irreversible. Cascades take the samples, steps, runs,
 * executions and results with them; nothing marked real is touched, and the
 * count is returned so the caller can report exactly what went.
 */
export async function clearTestData(actor: Actor): Promise<number> {
  assertAdmin(actor);
  const count = await db.$transaction(async (tx) => {
    const result = await tx.experiment.deleteMany({
      where: { organizationId: actor.org, isTest: true },
    });
    await recordUserAudit(tx, {
      actor,
      action: "experiment.test-data.cleared",
      entityType: "Organization",
      entityId: actor.org,
      changes: { count: result.count },
    });
    return result.count;
  });
  return count;
}
