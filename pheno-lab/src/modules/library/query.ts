import "server-only";

import { db } from "@/infrastructure/db/client";
import type { RecipePayload } from "@/lib/materials-meta";
import type { Actor } from "@/modules/authorization/actor";
import { isStaff } from "@/modules/authorization/policy";
import { getStewardships, hasStewardship } from "@/modules/stewardship/service";
import { canReadRecipeContents } from "./recipe-policy";
import { listMaterialEdits } from "./review-service";
import { listProjects } from "@/modules/experiments/project-service";

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
      include: {
        attachments: {
          orderBy: { createdAt: "asc" },
          select: { id: true, fileName: true, storedPath: true, size: true },
        },
      },
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
      organizationId: true,
      createdById: true,
      approvalStatus: true,
      payload: true,
    },
  });
  return {
    // Everyone reads the 课题组 list including retired ones here, so a manager
    // can see what was archived; only staff get the edit controls.
    projects: await listProjects(actor, { includeInactive: true }),
    processes,
    equipment,
    materials,
    locations,
    environments,
    presets,
    categories,
    materialAdmin,
    recipeAccess,
    materialEdits: await listMaterialEdits(actor),
    stewardships,
    layers,
    canEdit: isStaff(actor),
    recipes: recipes.map((recipe) => ({
      id: recipe.id,
      name: recipe.name,
      summary: canReadRecipeContents(actor, recipe, stewardships)
        ? recipe.summary
        : "",
      archived: recipe.archived,
      approvalStatus: recipe.approvalStatus,
      canRead: canReadRecipeContents(actor, recipe, stewardships),
      payload: canReadRecipeContents(actor, recipe, stewardships)
        ? ((recipe.payload as RecipePayload | null) ?? null)
        : null,
    })),
  };
}
