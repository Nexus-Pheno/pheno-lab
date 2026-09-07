import "server-only";

import { isDeepStrictEqual } from "node:util";
import type { Material, Prisma } from "@prisma/client";
import { db } from "@/infrastructure/db/client";
import { sendGroupNotice } from "@/modules/notifications/group-service";
import type { Actor } from "@/modules/authorization/actor";
import { recordUserAudit } from "@/modules/audit/writer";
import { notify, type NotificationKind } from "@/modules/notifications/service";
import {
  assertStewardship,
  hasStewardship,
} from "@/modules/stewardship/service";
import {
  libraryReviewSchema,
  materialCardSchema,
  materialEditSchema,
} from "./schema";

function snapshot(material: Material) {
  return {
    ...materialCardSchema.parse({
      ...material,
      properties: material.properties ?? {},
    }),
    archived: material.archived,
  };
}

export async function notifyLibraryReview(
  client: Prisma.TransactionClient,
  actor: Actor,
  kind: NotificationKind,
  entityLabel: string,
  target: "materialAdmin" | "recipeSteward" | { userId: string },
) {
  const sender = await client.user.findFirstOrThrow({
    where: { id: actor.uid, organizationId: actor.org, active: true },
    select: { name: true },
  });
  const recipients = await client.user.findMany({
    where: {
      organizationId: actor.org,
      active: true,
      ...(typeof target === "string"
        ? { OR: [{ role: "ADMIN" as const }, { [target]: true }] }
        : { id: target.userId }),
    },
    select: { id: true },
  });
  for (const recipient of recipients) {
    await notify(client, {
      organizationId: actor.org,
      userId: recipient.id,
      actorUserId: actor.uid,
      kind,
      actorName: sender.name,
      entityLabel,
      href: "/library",
    });
  }
}

export async function submitMaterialEdit(actor: Actor, raw: unknown) {
  const { materialId, changes } = materialEditSchema.parse(raw);
  const result = await db.$transaction(async (client) => {
    const material = await client.material.findFirstOrThrow({
      where: { id: materialId, organizationId: actor.org, archived: false },
    });
    if (
      changes.processId &&
      !(await client.process.count({
        where: { id: changes.processId, organizationId: actor.org },
      }))
    ) {
      throw new Error("Process not found in this organization.");
    }
    const proposal = await client.materialEditSuggestion.create({
      data: {
        organizationId: actor.org,
        materialId,
        createdById: actor.uid,
        baseSnapshot: snapshot(material) as Prisma.InputJsonValue,
        changes: changes as Prisma.InputJsonValue,
      },
    });
    await notifyLibraryReview(
      client,
      actor,
      "material_edit_requested",
      material.name,
      "materialAdmin",
    );
    await recordUserAudit(client, {
      actor,
      action: "library.material.edit_requested",
      entityType: "MaterialEditSuggestion",
      entityId: proposal.id,
      changes: { materialId },
    });
    return { id: proposal.id };
  });
  await sendGroupNotice(actor.org, "material_edit_requested");
  return result;
}

export async function reviewMaterialEdit(actor: Actor, raw: unknown) {
  await assertStewardship(actor, "materialAdmin");
  const { id, decision } = libraryReviewSchema.parse(raw);
  await db.$transaction(async (client) => {
    const claim = await client.materialEditSuggestion.updateMany({
      where: { id, organizationId: actor.org, status: "PENDING" },
      data: {
        status: decision,
        reviewedById: actor.uid,
        reviewedAt: new Date(),
      },
    });
    if (claim.count !== 1)
      throw new Error("Suggestion not found or already reviewed.");
    const suggestion = await client.materialEditSuggestion.findUniqueOrThrow({
      where: { id },
    });
    await client.$queryRaw`SELECT id FROM "Material" WHERE id = ${suggestion.materialId} AND "organizationId" = ${actor.org} FOR UPDATE`;
    const material = await client.material.findFirstOrThrow({
      where: { id: suggestion.materialId, organizationId: actor.org },
    });
    if (decision === "APPROVED") {
      if (!isDeepStrictEqual(snapshot(material), suggestion.baseSnapshot))
        throw new Error(
          "Material changed since this suggestion. Reject it and request a fresh suggestion.",
        );
      const changes = materialCardSchema.parse(suggestion.changes);
      if (
        changes.processId &&
        !(await client.process.count({
          where: { id: changes.processId, organizationId: actor.org },
        }))
      )
        throw new Error("Process not found in this organization.");
      await client.material.update({
        where: { id: material.id },
        data: {
          ...changes,
          properties: changes.properties as Prisma.InputJsonValue,
        },
      });
    }
    await recordUserAudit(client, {
      actor,
      action:
        decision === "APPROVED"
          ? "library.material.edit_approved"
          : "library.material.edit_rejected",
      entityType: "MaterialEditSuggestion",
      entityId: id,
      changes: { materialId: material.id },
    });
    await notifyLibraryReview(
      client,
      actor,
      decision === "APPROVED"
        ? "material_edit_approved"
        : "material_edit_rejected",
      material.name,
      { userId: suggestion.createdById },
    );
  });
}

export async function listMaterialEdits(actor: Actor) {
  const steward = await hasStewardship(actor, "materialAdmin");
  const rows = await db.materialEditSuggestion.findMany({
    where: {
      organizationId: actor.org,
      ...(steward
        ? { status: "PENDING" as const }
        : { createdById: actor.uid }),
    },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      material: { select: { name: true } },
      createdBy: { select: { name: true } },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    material: row.material.name,
    author: row.createdBy.name,
    status: row.status,
    changes: materialCardSchema.parse(row.changes),
    base: materialCardSchema.parse(row.baseSnapshot),
  }));
}

export async function reviewRecipe(actor: Actor, raw: unknown) {
  await assertStewardship(actor, "recipeSteward");
  const { id, decision } = libraryReviewSchema.parse(raw);
  await db.$transaction(async (client) => {
    const changed = await client.recipe.updateMany({
      where: {
        id,
        organizationId: actor.org,
        approvalStatus: "PENDING",
        archived: false,
      },
      data: { approvalStatus: decision },
    });
    if (changed.count !== 1)
      throw new Error("Recipe not found or already reviewed.");
    const recipe = await client.recipe.findUniqueOrThrow({
      where: { id },
      select: { name: true, createdById: true },
    });
    await recordUserAudit(client, {
      actor,
      action:
        decision === "APPROVED"
          ? "library.recipe.approved"
          : "library.recipe.rejected",
      entityType: "Recipe",
      entityId: id,
    });
    if (recipe.createdById)
      await notifyLibraryReview(
        client,
        actor,
        decision === "APPROVED" ? "recipe_approved" : "recipe_rejected",
        recipe.name,
        { userId: recipe.createdById },
      );
  });
}
