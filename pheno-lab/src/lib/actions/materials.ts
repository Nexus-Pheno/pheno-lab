"use server";

import { requireSession } from "@/lib/auth";
import type { MaterialCard, RecipePayload } from "@/lib/materials-meta";
import {
  createMaterialCategory as createMaterialCategoryService,
  deleteMaterialCategory as deleteMaterialCategoryService,
  getRecipePayload as getRecipePayloadService,
  listMaterialCategories as listMaterialCategoriesService,
  moveMaterialCategory as moveMaterialCategoryService,
  renameMaterialCategory as renameMaterialCategoryService,
  saveMaterialCard as saveMaterialCardService,
  saveRecipe as saveRecipeService,
  setMaterialArchived as setMaterialArchivedService,
  setRecipeArchived as setRecipeArchivedService,
  setUserStewardship,
} from "@/modules/library/service";
import { hasStewardship } from "@/modules/stewardship/service";

export async function hasMaterialAdmin(): Promise<boolean> {
  return hasStewardship(await requireSession(), "materialAdmin");
}

export async function hasRecipeAccess(): Promise<boolean> {
  return hasStewardship(await requireSession(), "recipeAccess");
}

export async function saveMaterialCard(id: string | null, card: MaterialCard) {
  return saveMaterialCardService(await requireSession(), id, card);
}

export async function setMaterialArchived(id: string, archived: boolean) {
  await setMaterialArchivedService(await requireSession(), id, archived);
}

export async function saveRecipe(
  id: string | null,
  data: { name: string; summary: string; payload: RecipePayload },
) {
  return saveRecipeService(await requireSession(), { id, data });
}

export async function setRecipeArchived(id: string, archived: boolean) {
  await setRecipeArchivedService(await requireSession(), id, archived);
}

export async function getRecipePayload(
  id: string,
): Promise<RecipePayload | null> {
  return (await getRecipePayloadService(
    await requireSession(),
    id,
  )) as RecipePayload | null;
}

export async function setUserPermission(
  userId: string,
  permission:
    "materialAdmin" | "equipmentAdmin" | "facilityAdmin" | "recipeAccess",
  value: boolean,
) {
  await setUserStewardship(await requireSession(), userId, permission, value);
}

export async function listMaterialCategories() {
  return listMaterialCategoriesService(await requireSession());
}

export async function createMaterialCategory(name: string, nameZh: string) {
  return createMaterialCategoryService(await requireSession(), {
    name,
    nameZh,
  });
}

export async function renameMaterialCategory(
  id: string,
  name: string,
  nameZh: string,
) {
  await renameMaterialCategoryService(await requireSession(), {
    id,
    name,
    nameZh,
  });
}

export async function deleteMaterialCategory(id: string, moveToCode: string) {
  await deleteMaterialCategoryService(await requireSession(), {
    id,
    moveToCode,
  });
}

export async function moveMaterialCategory(
  id: string,
  direction: "up" | "down",
) {
  await moveMaterialCategoryService(await requireSession(), { id, direction });
}
