import "server-only";

import { Prisma } from "@prisma/client";
import { db } from "@/infrastructure/db/client";
import type { Actor } from "@/modules/authorization/actor";
import { assertAdmin, assertStaff } from "@/modules/authorization/policy";
import { recordUserAudit } from "@/modules/audit/writer";
import { assertStewardship } from "@/modules/stewardship/service";
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

export async function saveStepPreset(
  actor: Actor,
  rawName: unknown,
  processId: string,
  rawPayload: unknown,
) {
  assertStaff(actor);
  const name = presetNameSchema.parse(rawName);
  processId = experimentIdSchema.parse(processId);
  const payload = stepPresetPayloadSchema.parse(rawPayload);
  return db.$transaction(async (tx) => {
    await assertPresetReferences(tx, actor, processId, payload);
    const row = await tx.preset.create({
      data: {
        organizationId: actor.org,
        kind: "STEP",
        processId,
        name,
        payload: payload as unknown as Prisma.InputJsonValue,
        createdById: actor.uid,
      },
    });
    await recordUserAudit(tx, {
      actor,
      action: "library.preset.created",
      entityType: "Preset",
      entityId: row.id,
      metadata: { kind: "STEP", processId },
    });
    return row;
  });
}

export async function saveCharPreset(
  actor: Actor,
  rawName: unknown,
  processId: string,
  rawPayload: unknown,
) {
  assertStaff(actor);
  const name = presetNameSchema.parse(rawName);
  processId = experimentIdSchema.parse(processId);
  const payload = charPresetPayloadSchema.parse(rawPayload);
  return db.$transaction(async (tx) => {
    await assertPresetReferences(tx, actor, processId, payload);
    const row = await tx.preset.create({
      data: {
        organizationId: actor.org,
        kind: "CHARACTERIZATION",
        processId,
        name,
        payload: payload as unknown as Prisma.InputJsonValue,
        createdById: actor.uid,
      },
    });
    await recordUserAudit(tx, {
      actor,
      action: "library.preset.created",
      entityType: "Preset",
      entityId: row.id,
      metadata: { kind: "CHARACTERIZATION", processId },
    });
    return row;
  });
}

export async function deletePreset(actor: Actor, rawId: unknown) {
  assertStaff(actor);
  const id = experimentIdSchema.parse(rawId);
  await db.$transaction(async (tx) => {
    const result = await tx.preset.deleteMany({
      where: { id, organizationId: actor.org },
    });
    if (result.count !== 1) throw new Error("Preset not found.");
    await recordUserAudit(tx, {
      actor,
      action: "library.preset.deleted",
      entityType: "Preset",
      entityId: id,
    });
  });
}

// ---- Quick-create from the designer ----

export async function quickCreateMaterial(
  actor: Actor,
  rawName: unknown,
  processId: string | null,
) {
  await assertStewardship(actor, "materialAdmin");
  const name = presetNameSchema.parse(rawName);
  if (processId) processId = experimentIdSchema.parse(processId);
  return db.$transaction(async (tx) => {
    if (processId) {
      const process = await tx.process.count({
        where: { id: processId, organizationId: actor.org },
      });
      if (!process) throw new Error("Process belongs to another organization.");
    }
    const row = await tx.material.create({
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
// Admin and managers can edit any preset; technicians only their own.

export async function updatePreset(
  actor: Actor,
  rawId: unknown,
  rawData: unknown,
) {
  const id = experimentIdSchema.parse(rawId);
  const data = presetUpdateSchema.parse(rawData);
  const preset = await db.preset.findUniqueOrThrow({ where: { id } });
  if (preset.organizationId !== actor.org)
    throw new Error("Preset belongs to another organization.");
  if (actor.role === "TECHNICIAN" && preset.createdById !== actor.uid) {
    throw new Error("Technicians can only edit their own presets.");
  }
  if (data.payload) {
    await db.$transaction((tx) =>
      assertPresetReferences(tx, actor, preset.processId, data.payload!),
    );
  }
  await db.$transaction(async (tx) => {
    await tx.preset.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.payload !== undefined
          ? { payload: data.payload as unknown as Prisma.InputJsonValue }
          : {}),
      },
    });
    await recordUserAudit(tx, {
      actor,
      action: "library.preset.updated",
      entityType: "Preset",
      entityId: id,
      changes: {
        name: data.name,
        payloadUpdated: data.payload !== undefined,
      },
    });
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
    where: { organizationId: actor.org, isTest: true },
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
    await tx.experiment.update({ where: { id }, data: { isTest } });
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
