import "server-only";

import { db } from "@/infrastructure/db/client";
import type { RecipePayload } from "@/lib/materials-meta";
import type { Actor } from "@/modules/authorization/actor";
import { isStaff } from "@/modules/authorization/policy";
import { getStewardships, hasStewardship } from "@/modules/stewardship/service";

export async function getLibraryPageData(actor: Actor) {
  const where = { organizationId: actor.org };
  const [
    processes,
    equipment,
    materials,
    locations,
    environments,
    presets,
    categories,
    materialAdmin,
    recipeAccess,
    stewardships,
    layers,
  ] = await Promise.all([
    db.process.findMany({
      where,
      orderBy: [{ archived: "asc" }, { position: "asc" }],
    }),
    db.equipment.findMany({
      where,
      orderBy: [{ archived: "asc" }, { name: "asc" }],
      include: {
        attachments: {
          orderBy: { createdAt: "asc" },
          select: { id: true, fileName: true, storedPath: true, size: true },
        },
      },
    }),
    db.material.findMany({
      where,
      orderBy: [{ archived: "asc" }, { name: "asc" }],
    }),
    db.location.findMany({ where, orderBy: { name: "asc" } }),
    db.labEnvironment.findMany({
      where,
      orderBy: [{ archived: "asc" }, { name: "asc" }],
    }),
    db.preset.findMany({
      where,
      orderBy: { usageCount: "desc" },
      include: {
        createdBy: { select: { name: true } },
        process: { select: { name: true } },
      },
    }),
    db.materialCategoryDef.findMany({
      where,
      orderBy: { position: "asc" },
    }),
    hasStewardship(actor, "materialAdmin"),
    hasStewardship(actor, "recipeAccess"),
    getStewardships(actor),
    db.deviceLayer.findMany({
      where,
      orderBy: { position: "asc" },
      select: { code: true, name: true },
    }),
  ]);
  const recipes = await db.recipe.findMany({
    where,
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      summary: true,
      archived: true,
      ...(recipeAccess ? { payload: true } : {}),
    },
  });
  return {
    processes,
    equipment,
    materials,
    locations,
    environments,
    presets,
    categories,
    materialAdmin,
    recipeAccess,
    stewardships,
    layers,
    canEdit: isStaff(actor),
    recipes: recipes.map((recipe) => ({
      id: recipe.id,
      name: recipe.name,
      summary: recipe.summary,
      archived: recipe.archived,
      payload:
        recipeAccess && "payload" in recipe
          ? ((recipe.payload as RecipePayload | null) ?? null)
          : null,
    })),
  };
}
