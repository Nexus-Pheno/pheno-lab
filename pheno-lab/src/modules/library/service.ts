import "server-only";

import { Prisma } from "@prisma/client";
import { db } from "@/infrastructure/db/client";
import type { Actor } from "@/modules/authorization/actor";
import { assertAdmin, assertStaff } from "@/modules/authorization/policy";
import { recordUserAudit } from "@/modules/audit/writer";
import { assertStewardship } from "@/modules/stewardship/service";
import {
  categoryCreateSchema,
  categoryDeleteSchema,
  categoryMoveSchema,
  categoryRenameSchema,
  environmentCreateSchema,
  environmentUpdateSchema,
  equipmentCreateSchema,
  equipmentUpdateSchema,
  libraryMaterialCreateSchema,
  libraryMaterialUpdateSchema,
  locationCreateSchema,
  locationUpdateSchema,
  materialCardSchema,
  permissionSchema,
  processCreateSchema,
  processUpdateSchema,
  recipeSaveSchema,
} from "./schema";

async function requireOrgProcess(
  client: Prisma.TransactionClient,
  actor: Actor,
  processId: string | null | undefined,
): Promise<void> {
  if (!processId) return;
  const count = await client.process.count({
    where: { id: processId, organizationId: actor.org },
  });
  if (!count) throw new Error("Process not found in this organization.");
}

async function requireOrgLocation(
  client: Prisma.TransactionClient,
  actor: Actor,
  locationId: string | null | undefined,
): Promise<void> {
  if (!locationId) return;
  const count = await client.location.count({
    where: { id: locationId, organizationId: actor.org },
  });
  if (!count) throw new Error("Location not found in this organization.");
}

function assertUpdated(count: number, label: string): void {
  if (count !== 1) throw new Error(`${label} not found.`);
}

export async function createProcess(actor: Actor, raw: unknown) {
  assertStaff(actor);
  const input = processCreateSchema.parse(raw);
  return db.$transaction(async (tx) => {
    const position = await tx.process.count({
      where: { organizationId: actor.org },
    });
    const row = await tx.process.create({
      data: { ...input, organizationId: actor.org, position },
    });
    await recordUserAudit(tx, {
      actor,
      action: "library.process.created",
      entityType: "Process",
      entityId: row.id,
      changes: { name: row.name, kind: row.kind },
    });
    return row;
  });
}

export async function updateProcess(actor: Actor, raw: unknown) {
  assertStaff(actor);
  const { id, data } = processUpdateSchema.parse(raw);
  await db.$transaction(async (tx) => {
    const result = await tx.process.updateMany({
      where: { id, organizationId: actor.org },
      data: {
        ...data,
        parameters: data.parameters as Prisma.InputJsonValue | undefined,
      },
    });
    assertUpdated(result.count, "Process");
    await recordUserAudit(tx, {
      actor,
      action: "library.process.updated",
      entityType: "Process",
      entityId: id,
      changes: data,
    });
  });
}

export async function createLocation(actor: Actor, raw: unknown) {
  await assertStewardship(actor, "facilityAdmin");
  const input = locationCreateSchema.parse(raw);
  return db.$transaction(async (tx) => {
    const row = await tx.location.create({
      data: { organizationId: actor.org, name: input.name },
    });
    await recordUserAudit(tx, {
      actor,
      action: "library.location.created",
      entityType: "Location",
      entityId: row.id,
      changes: input,
    });
    return row;
  });
}

export async function updateLocation(actor: Actor, raw: unknown) {
  await assertStewardship(actor, "facilityAdmin");
  const { id, data } = locationUpdateSchema.parse(raw);
  await db.$transaction(async (tx) => {
    const result = await tx.location.updateMany({
      where: { id, organizationId: actor.org },
      data,
    });
    assertUpdated(result.count, "Location");
    await recordUserAudit(tx, {
      actor,
      action: "library.location.updated",
      entityType: "Location",
      entityId: id,
      changes: data,
    });
  });
}

export async function createEquipment(actor: Actor, raw: unknown) {
  await assertStewardship(actor, "equipmentAdmin");
  const input = equipmentCreateSchema.parse(raw);
  return db.$transaction(async (tx) => {
    await requireOrgProcess(tx, actor, input.processId);
    await requireOrgLocation(tx, actor, input.locationId);
    const row = await tx.equipment.create({
      data: {
        ...input,
        parameters: input.parameters as Prisma.InputJsonValue,
        organizationId: actor.org,
      },
    });
    await recordUserAudit(tx, {
      actor,
      action: "library.equipment.created",
      entityType: "Equipment",
      entityId: row.id,
      changes: { name: row.name, processId: row.processId },
    });
    return row;
  });
}

export async function updateEquipment(actor: Actor, raw: unknown) {
  await assertStewardship(actor, "equipmentAdmin");
  const { id, data } = equipmentUpdateSchema.parse(raw);
  await db.$transaction(async (tx) => {
    await requireOrgProcess(tx, actor, data.processId);
    await requireOrgLocation(tx, actor, data.locationId);
    const result = await tx.equipment.updateMany({
      where: { id, organizationId: actor.org },
      data: {
        ...data,
        parameters: data.parameters as Prisma.InputJsonValue | undefined,
      },
    });
    assertUpdated(result.count, "Equipment");
    await recordUserAudit(tx, {
      actor,
      action: "library.equipment.updated",
      entityType: "Equipment",
      entityId: id,
      changes: data,
    });
  });
}

export async function createEnvironment(actor: Actor, raw: unknown) {
  await assertStewardship(actor, "facilityAdmin");
  const input = environmentCreateSchema.parse(raw);
  return db.$transaction(async (tx) => {
    const row = await tx.labEnvironment.create({
      data: {
        organizationId: actor.org,
        name: input.name,
        conditions: input.conditions as Prisma.InputJsonValue,
        notes: input.notes,
      },
    });
    await recordUserAudit(tx, {
      actor,
      action: "library.environment.created",
      entityType: "LabEnvironment",
      entityId: row.id,
      changes: { name: row.name },
    });
    return row;
  });
}

export async function updateEnvironment(actor: Actor, raw: unknown) {
  await assertStewardship(actor, "facilityAdmin");
  const { id, data } = environmentUpdateSchema.parse(raw);
  await db.$transaction(async (tx) => {
    const result = await tx.labEnvironment.updateMany({
      where: { id, organizationId: actor.org },
      data: {
        ...data,
        conditions: data.conditions as Prisma.InputJsonValue | undefined,
      },
    });
    assertUpdated(result.count, "Environment");
    await recordUserAudit(tx, {
      actor,
      action: "library.environment.updated",
      entityType: "LabEnvironment",
      entityId: id,
      changes: data,
    });
  });
}

export async function createLibraryMaterial(actor: Actor, raw: unknown) {
  await assertStewardship(actor, "materialAdmin");
  const input = libraryMaterialCreateSchema.parse(raw);
  return db.$transaction(async (tx) => {
    await requireOrgProcess(tx, actor, input.processId);
    const row = await tx.material.create({
      data: { ...input, organizationId: actor.org },
    });
    await recordUserAudit(tx, {
      actor,
      action: "library.material.created",
      entityType: "Material",
      entityId: row.id,
      changes: { name: row.name, processId: row.processId },
    });
    return row;
  });
}

export async function updateLibraryMaterial(actor: Actor, raw: unknown) {
  await assertStewardship(actor, "materialAdmin");
  const { id, data } = libraryMaterialUpdateSchema.parse(raw);
  await db.$transaction(async (tx) => {
    await requireOrgProcess(tx, actor, data.processId);
    const result = await tx.material.updateMany({
      where: { id, organizationId: actor.org },
      data,
    });
    assertUpdated(result.count, "Material");
    await recordUserAudit(tx, {
      actor,
      action: "library.material.updated",
      entityType: "Material",
      entityId: id,
      changes: data,
    });
  });
}

export async function saveMaterialCard(
  actor: Actor,
  id: string | null,
  raw: unknown,
) {
  await assertStewardship(actor, "materialAdmin");
  const card = materialCardSchema.parse(raw);
  return db.$transaction(async (tx) => {
    await requireOrgProcess(tx, actor, card.processId);
    const data = {
      ...card,
      properties: card.properties as Prisma.InputJsonValue,
    };
    const row = id
      ? await tx.material.update({
          where: { id, organizationId: actor.org },
          data,
        })
      : await tx.material.create({
          data: { ...data, organizationId: actor.org },
        });
    await recordUserAudit(tx, {
      actor,
      action: id ? "library.material.updated" : "library.material.created",
      entityType: "Material",
      entityId: row.id,
      changes: { name: row.name, category: row.category },
    });
    return row;
  });
}

export async function setMaterialArchived(
  actor: Actor,
  id: string,
  archived: boolean,
) {
  await assertStewardship(actor, "materialAdmin");
  await db.$transaction(async (tx) => {
    const result = await tx.material.updateMany({
      where: { id, organizationId: actor.org },
      data: { archived },
    });
    assertUpdated(result.count, "Material");
    await recordUserAudit(tx, {
      actor,
      action: archived
        ? "library.material.archived"
        : "library.material.restored",
      entityType: "Material",
      entityId: id,
    });
  });
}

export async function saveRecipe(actor: Actor, raw: unknown) {
  await assertStewardship(actor, "recipeAccess");
  const { id, data } = recipeSaveSchema.parse(raw);
  const clean = {
    name: data.name,
    summary: data.summary,
    payload: {
      ...data.payload,
      components: data.payload.components.filter((item) => item.material),
    } as Prisma.InputJsonValue,
  };
  return db.$transaction(async (tx) => {
    const row = id
      ? await tx.recipe.update({
          where: { id, organizationId: actor.org },
          data: clean,
        })
      : await tx.recipe.create({
          data: {
            ...clean,
            organizationId: actor.org,
            createdById: actor.uid,
          },
        });
    await recordUserAudit(tx, {
      actor,
      action: id ? "library.recipe.updated" : "library.recipe.created",
      entityType: "Recipe",
      entityId: row.id,
      changes: { name: row.name, summary: row.summary },
    });
    return row;
  });
}

export async function setRecipeArchived(
  actor: Actor,
  id: string,
  archived: boolean,
) {
  await assertStewardship(actor, "recipeAccess");
  await db.$transaction(async (tx) => {
    const result = await tx.recipe.updateMany({
      where: { id, organizationId: actor.org },
      data: { archived },
    });
    assertUpdated(result.count, "Recipe");
    await recordUserAudit(tx, {
      actor,
      action: archived ? "library.recipe.archived" : "library.recipe.restored",
      entityType: "Recipe",
      entityId: id,
    });
  });
}

export async function getRecipePayload(actor: Actor, id: string) {
  await assertStewardship(actor, "recipeAccess");
  const row = await db.recipe.findFirst({
    where: { id, organizationId: actor.org },
    select: { payload: true },
  });
  return row?.payload ?? null;
}

export async function setUserStewardship(
  actor: Actor,
  userId: string,
  rawPermission: unknown,
  value: boolean,
) {
  assertAdmin(actor);
  const permission = permissionSchema.parse(rawPermission);
  await db.$transaction(async (tx) => {
    const result = await tx.user.updateMany({
      where: { id: userId, organizationId: actor.org },
      data: { [permission]: value },
    });
    assertUpdated(result.count, "User");
    await recordUserAudit(tx, {
      actor,
      action: "user.stewardship.updated",
      entityType: "User",
      entityId: userId,
      changes: { permission, value },
    });
  });
}

export async function listMaterialCategories(actor: Actor) {
  return db.materialCategoryDef.findMany({
    where: { organizationId: actor.org },
    orderBy: { position: "asc" },
  });
}

export async function createMaterialCategory(actor: Actor, raw: unknown) {
  await assertStewardship(actor, "materialAdmin");
  const input = categoryCreateSchema.parse(raw);
  return db.$transaction(async (tx) => {
    const base =
      input.name
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, "_")
        .replace(/^_|_$/g, "") || "CATEGORY";
    let code = base;
    for (
      let index = 2;
      await tx.materialCategoryDef.findFirst({
        where: { organizationId: actor.org, code },
      });
      index += 1
    ) {
      code = `${base}_${index}`;
    }
    const maximum = await tx.materialCategoryDef.aggregate({
      where: { organizationId: actor.org },
      _max: { position: true },
    });
    const row = await tx.materialCategoryDef.create({
      data: {
        organizationId: actor.org,
        code,
        name: input.name,
        nameZh: input.nameZh,
        position: (maximum._max.position ?? 0) + 1,
      },
    });
    await recordUserAudit(tx, {
      actor,
      action: "library.material_category.created",
      entityType: "MaterialCategoryDef",
      entityId: row.id,
      changes: { code: row.code, name: row.name },
    });
    return row;
  });
}

export async function renameMaterialCategory(actor: Actor, raw: unknown) {
  await assertStewardship(actor, "materialAdmin");
  const { id, name, nameZh } = categoryRenameSchema.parse(raw);
  await db.$transaction(async (tx) => {
    const result = await tx.materialCategoryDef.updateMany({
      where: { id, organizationId: actor.org },
      data: { name, nameZh },
    });
    assertUpdated(result.count, "Category");
    await recordUserAudit(tx, {
      actor,
      action: "library.material_category.renamed",
      entityType: "MaterialCategoryDef",
      entityId: id,
      changes: { name, nameZh },
    });
  });
}

export async function deleteMaterialCategory(actor: Actor, raw: unknown) {
  await assertStewardship(actor, "materialAdmin");
  const { id, moveToCode } = categoryDeleteSchema.parse(raw);
  await db.$transaction(async (tx) => {
    const category = await tx.materialCategoryDef.findFirst({
      where: { id, organizationId: actor.org },
    });
    if (!category) throw new Error("Category not found.");
    const target = await tx.materialCategoryDef.findFirst({
      where: { organizationId: actor.org, code: moveToCode },
    });
    if (!target || target.id === category.id) {
      throw new Error("Pick a different category to move materials into.");
    }
    const moved = await tx.material.updateMany({
      where: { organizationId: actor.org, category: category.code },
      data: { category: target.code },
    });
    await tx.materialCategoryDef.delete({ where: { id: category.id } });
    await recordUserAudit(tx, {
      actor,
      action: "library.material_category.deleted",
      entityType: "MaterialCategoryDef",
      entityId: id,
      changes: { from: category.code, to: target.code, moved: moved.count },
    });
  });
}

export async function moveMaterialCategory(actor: Actor, raw: unknown) {
  await assertStewardship(actor, "materialAdmin");
  const { id, direction } = categoryMoveSchema.parse(raw);
  await db.$transaction(async (tx) => {
    const rows = await tx.materialCategoryDef.findMany({
      where: { organizationId: actor.org },
      orderBy: { position: "asc" },
    });
    const index = rows.findIndex((row) => row.id === id);
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (index < 0) throw new Error("Category not found.");
    if (targetIndex < 0 || targetIndex >= rows.length) return;
    await tx.materialCategoryDef.update({
      where: { id: rows[index].id },
      data: { position: rows[targetIndex].position },
    });
    await tx.materialCategoryDef.update({
      where: { id: rows[targetIndex].id },
      data: { position: rows[index].position },
    });
    await recordUserAudit(tx, {
      actor,
      action: "library.material_category.reordered",
      entityType: "MaterialCategoryDef",
      entityId: id,
      changes: { direction },
    });
  });
}
