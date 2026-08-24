"use server";

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireSession, requireAdmin, type Session } from "@/lib/auth";
import { assertSteward } from "@/lib/actions/stewardship";
import type { MaterialCard, RecipePayload } from "@/lib/materials-meta";

// Materials are a curated, org-wide library maintained by material
// administrators (User.materialAdmin, or any org admin). Recipes are
// proprietary: contents readable/editable only with recipeAccess.

async function assertMaterialAdmin(): Promise<Session> {
  return assertSteward("materialAdmin");
}

async function assertRecipeAccess(): Promise<Session> {
  return assertSteward("recipeAccess");
}

export async function hasMaterialAdmin(): Promise<boolean> {
  try { await assertMaterialAdmin(); return true; } catch { return false; }
}

export async function hasRecipeAccess(): Promise<boolean> {
  try { await assertRecipeAccess(); return true; } catch { return false; }
}

export async function saveMaterialCard(id: string | null, card: MaterialCard) {
  const session = await assertMaterialAdmin();
  const data = {
    name: card.name.trim(),
    category: card.category,
    composition: card.composition.trim(),
    smiles: card.smiles.trim(),
    casNumber: card.casNumber.trim(),
    molecularWeight: card.molecularWeight.trim(),
    purity: card.purity.trim(),
    supplier: card.supplier.trim(),
    lot: card.lot.trim(),
    properties: card.properties as Prisma.InputJsonValue,
    notes: card.notes,
    processId: card.processId,
  };
  if (!data.name) throw new Error("Material name is required.");
  if (id) {
    const existing = await db.material.findFirst({ where: { id, organizationId: session.org } });
    if (!existing) throw new Error("Material not found.");
    return db.material.update({ where: { id }, data });
  }
  return db.material.create({ data: { ...data, organizationId: session.org } });
}

export async function setMaterialArchived(id: string, archived: boolean) {
  const session = await assertMaterialAdmin();
  await db.material.updateMany({ where: { id, organizationId: session.org }, data: { archived } });
}

// ---- Recipes ----

export async function saveRecipe(
  id: string | null,
  data: { name: string; summary: string; payload: RecipePayload }
) {
  const session = await assertRecipeAccess();
  const clean = {
    name: data.name.trim(),
    summary: data.summary.trim(),
    payload: {
      ...data.payload,
      components: data.payload.components.filter((c) => c.material.trim()),
    } as Prisma.InputJsonValue,
  };
  if (!clean.name) throw new Error("Recipe name is required.");
  if (id) {
    const existing = await db.recipe.findFirst({ where: { id, organizationId: session.org } });
    if (!existing) throw new Error("Recipe not found.");
    return db.recipe.update({ where: { id }, data: clean });
  }
  return db.recipe.create({ data: { ...clean, organizationId: session.org, createdById: session.uid } });
}

export async function setRecipeArchived(id: string, archived: boolean) {
  const session = await assertRecipeAccess();
  await db.recipe.updateMany({ where: { id, organizationId: session.org }, data: { archived } });
}

/** Recipe contents for one recipe — only with recipeAccess. */
export async function getRecipePayload(id: string): Promise<RecipePayload | null> {
  const session = await assertRecipeAccess();
  const r = await db.recipe.findFirst({ where: { id, organizationId: session.org } });
  return (r?.payload as RecipePayload | null) ?? null;
}

// ---- Admin: extra permissions (Users page) ----

export async function setUserPermission(
  userId: string,
  permission: "materialAdmin" | "equipmentAdmin" | "facilityAdmin" | "recipeAccess",
  value: boolean
) {
  const session = await requireAdmin();
  await db.user.updateMany({
    where: { id: userId, organizationId: session.org },
    data: { [permission]: value },
  });
}

// ---- Material categories (org-defined) ----

export async function listMaterialCategories() {
  const session = await requireSession();
  return db.materialCategoryDef.findMany({
    where: { organizationId: session.org },
    orderBy: { position: "asc" },
  });
}

export async function createMaterialCategory(name: string, nameZh: string) {
  const session = await assertMaterialAdmin();
  const clean = name.trim();
  if (!clean) throw new Error("Category name is required.");
  // Stable code derived from the name; never changes when renamed.
  const base = clean.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "") || "CATEGORY";
  let code = base;
  for (let i = 2; await db.materialCategoryDef.findFirst({ where: { organizationId: session.org, code } }); i++) {
    code = `${base}_${i}`;
  }
  const max = await db.materialCategoryDef.aggregate({
    where: { organizationId: session.org },
    _max: { position: true },
  });
  return db.materialCategoryDef.create({
    data: {
      organizationId: session.org,
      code,
      name: clean,
      nameZh: nameZh.trim(),
      position: (max._max.position ?? 0) + 1,
    },
  });
}

export async function renameMaterialCategory(id: string, name: string, nameZh: string) {
  const session = await assertMaterialAdmin();
  if (!name.trim()) throw new Error("Category name is required.");
  await db.materialCategoryDef.updateMany({
    where: { id, organizationId: session.org },
    data: { name: name.trim(), nameZh: nameZh.trim() },
  });
}

/** Delete a category; its materials move to the fallback category. */
export async function deleteMaterialCategory(id: string, moveToCode: string) {
  const session = await assertMaterialAdmin();
  const cat = await db.materialCategoryDef.findFirst({ where: { id, organizationId: session.org } });
  if (!cat) throw new Error("Category not found.");
  const target = await db.materialCategoryDef.findFirst({
    where: { organizationId: session.org, code: moveToCode },
  });
  if (!target || target.id === cat.id) throw new Error("Pick a different category to move materials into.");
  await db.material.updateMany({
    where: { organizationId: session.org, category: cat.code },
    data: { category: target.code },
  });
  await db.materialCategoryDef.delete({ where: { id: cat.id } });
}

export async function moveMaterialCategory(id: string, direction: "up" | "down") {
  const session = await assertMaterialAdmin();
  const all = await db.materialCategoryDef.findMany({
    where: { organizationId: session.org },
    orderBy: { position: "asc" },
  });
  const i = all.findIndex((c) => c.id === id);
  const j = direction === "up" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= all.length) return;
  await db.$transaction([
    db.materialCategoryDef.update({ where: { id: all[i].id }, data: { position: all[j].position } }),
    db.materialCategoryDef.update({ where: { id: all[j].id }, data: { position: all[i].position } }),
  ]);
}
