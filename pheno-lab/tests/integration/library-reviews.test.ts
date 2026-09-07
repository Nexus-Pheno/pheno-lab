import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/infrastructure/db/client";
import type { Actor } from "@/modules/authorization/actor";
import {
  saveMaterialCard,
  saveRecipe,
  getRecipePayload,
  setRecipeArchived,
  setUserStewardship,
  setMaterialArchived,
  updateLibraryMaterial,
} from "@/modules/library/service";
import {
  submitMaterialEdit,
  reviewMaterialEdit,
  reviewRecipe,
  listMaterialEdits,
} from "@/modules/library/review-service";
import { getLibraryPageData } from "@/modules/library/query";
import { quickCreateMaterial } from "@/modules/experiments/service";
import { getExperimentDesignerData } from "@/modules/experiments/query";
import {
  publishIngestItem,
  findDuplicates,
  getIngestPayload,
  listIngestItems,
  updateIngestPayload,
  rejectIngestItem,
  markIngestDuplicate,
  deleteIngestItem,
} from "@/modules/ingest/service";
import { getIngestReviewData } from "@/modules/ingest/query";

afterAll(() => db.$disconnect());

async function fixture() {
  const organization = await db.organization.create({
    data: { name: "Review test", slug: `review-${crypto.randomUUID()}` },
  });
  const actors: Actor[] = [];
  for (const role of [
    "ADMIN",
    "MANAGER",
    "TECHNICIAN",
    "TECHNICIAN",
  ] as const) {
    const user = await db.user.create({
      data: {
        organizationId: organization.id,
        name: role,
        email: `${crypto.randomUUID()}@example.test`,
        role,
        passwordHash: "test-only",
        materialAdmin: role === "MANAGER",
        recipeSteward: role === "MANAGER",
      },
    });
    actors.push({ uid: user.id, org: organization.id, role });
  }
  return {
    organization,
    admin: actors[0],
    steward: actors[1],
    author: actors[2],
    reader: actors[3],
    async cleanup() {
      await db.ingestItem.deleteMany({
        where: { organizationId: organization.id },
      });
      await db.experiment.deleteMany({
        where: { organizationId: organization.id },
      });
      await db.notification.deleteMany({
        where: { organizationId: organization.id },
      });
      await db.auditEvent.deleteMany({
        where: { organizationId: organization.id },
      });
      await db.material.deleteMany({
        where: { organizationId: organization.id },
      });
      await db.recipe.deleteMany({
        where: { organizationId: organization.id },
      });
      await db.user.deleteMany({ where: { organizationId: organization.id } });
      await db.organization.delete({ where: { id: organization.id } });
    },
  };
}

const card = {
  name: "Test material",
  category: "OTHER",
  composition: "",
  smiles: "",
  casNumber: "",
  molecularWeight: "",
  purity: "",
  supplier: "",
  lot: "",
  properties: { first: "value", second: "value" },
  notes: "",
  processId: null,
};
const recipeData = {
  name: "Test recipe",
  summary: "private summary",
  payload: {
    components: [{ material: "test material", amount: "1" }],
    solvents: "test solvent",
    concentration: "test value",
    procedure: "private procedure",
  },
};

describe("library review workflows on PostgreSQL", () => {
  it("keeps the designer recipe picker inside the same approved-content policy", async () => {
    const context = await fixture();
    try {
      const experiment = await db.experiment.create({
        data: {
          organizationId: context.organization.id,
          createdById: context.reader.uid,
          code: `REVIEW-${crypto.randomUUID()}`,
          title: "Recipe picker test",
        },
      });
      const recipe = await saveRecipe(context.author, {
        id: null,
        data: recipeData,
      });
      await setUserStewardship(
        context.admin,
        context.reader.uid,
        "recipeAccess",
        true,
      );
      const pending = await getExperimentDesignerData(
        context.reader,
        experiment.id,
      );
      expect(pending?.recipes).toEqual([
        { id: recipe.id, name: recipe.name, summary: "" },
      ]);
      expect(pending?.canManageMaterials).toBe(true);
      await reviewRecipe(context.steward, {
        id: recipe.id,
        decision: "APPROVED",
      });
      const approved = await getExperimentDesignerData(
        context.reader,
        experiment.id,
      );
      expect(approved?.recipes[0].summary).toBe(recipeData.summary);
    } finally {
      await context.cleanup();
    }
  });

  it("does not let intake publishing or duplicate inspection bypass stewardship", async () => {
    const context = await fixture();
    try {
      await setUserStewardship(
        context.admin,
        context.steward.uid,
        "materialAdmin",
        false,
      );
      await setUserStewardship(
        context.admin,
        context.steward.uid,
        "recipeSteward",
        false,
      );
      await setUserStewardship(
        context.admin,
        context.steward.uid,
        "recipeAccess",
        true,
      );
      const material = await saveMaterialCard(context.author, null, card);
      const item = await db.ingestItem.create({
        data: {
          organizationId: context.organization.id,
          title: "Intake material",
          kind: "MATERIAL",
          payload: { name: "Changed material" },
        },
      });
      const resolution = { mode: "UPDATE", targetId: material.id };
      await expect(
        publishIngestItem(
          context.steward,
          item.id,
          { name: "Changed material" },
          "",
          resolution,
        ),
      ).rejects.toThrow();
      expect(
        (await db.material.findUniqueOrThrow({ where: { id: material.id } }))
          .name,
      ).toBe(card.name);
      expect(
        (await db.ingestItem.findUniqueOrThrow({ where: { id: item.id } }))
          .status,
      ).toBe("PENDING");
      await setUserStewardship(
        context.admin,
        context.steward.uid,
        "materialAdmin",
        true,
      );
      await publishIngestItem(
        context.steward,
        item.id,
        { name: "Changed material" },
        "",
        resolution,
      );
      expect(
        (await db.material.findUniqueOrThrow({ where: { id: material.id } }))
          .name,
      ).toBe("Changed material");
      const recipe = await saveRecipe(context.author, {
        id: null,
        data: recipeData,
      });
      const formula = await db.ingestItem.create({
        data: {
          organizationId: context.organization.id,
          title: recipe.name,
          kind: "FORMULA",
          payload: { ...recipeData.payload, name: recipe.name },
        },
      });
      await expect(
        findDuplicates(context.steward, "FORMULA", { name: recipe.name }),
      ).rejects.toThrow();
      await expect(
        getIngestPayload(context.steward, formula.id),
      ).rejects.toThrow();
      expect(
        (await listIngestItems(context.steward)).some(
          (row) => row.id === formula.id,
        ),
      ).toBe(false);
      expect(
        (await getIngestReviewData(context.steward)).items.some(
          (row) => row.id === formula.id,
        ),
      ).toBe(false);
      await expect(
        updateIngestPayload(
          context.steward,
          formula.id,
          { name: "Bypass" },
          "",
        ),
      ).rejects.toThrow();
      await expect(
        rejectIngestItem(context.steward, formula.id, ""),
      ).rejects.toThrow();
      await expect(
        markIngestDuplicate(context.steward, formula.id, ""),
      ).rejects.toThrow();
      await expect(
        deleteIngestItem(context.steward, formula.id),
      ).rejects.toThrow();
      await expect(
        publishIngestItem(
          context.steward,
          formula.id,
          { ...recipeData.payload, name: recipe.name },
          "",
          { mode: "UPDATE", targetId: recipe.id },
        ),
      ).rejects.toThrow();
      await setUserStewardship(
        context.admin,
        context.steward.uid,
        "recipeSteward",
        true,
      );
      expect(await getIngestPayload(context.steward, formula.id)).toMatchObject(
        recipeData.payload,
      );
      expect(
        await findDuplicates(context.steward, "FORMULA", { name: recipe.name }),
      ).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: recipe.id })]),
      );
      await publishIngestItem(
        context.steward,
        formula.id,
        { ...recipeData.payload, name: recipe.name },
        "",
        { mode: "UPDATE", targetId: recipe.id },
      );
      expect(
        (await db.recipe.findUniqueOrThrow({ where: { id: recipe.id } }))
          .approvalStatus,
      ).toBe("APPROVED");
    } finally {
      await context.cleanup();
    }
  });

  it("opens creation but requires approval for non-steward material edits", async () => {
    const context = await fixture();
    try {
      const material = await saveMaterialCard(context.author, null, card);
      await expect(
        quickCreateMaterial(context.author, "Quick material", null),
      ).resolves.toMatchObject({ name: "Quick material" });
      await expect(
        saveMaterialCard(context.author, material.id, {
          ...card,
          name: "Bypass",
        }),
      ).rejects.toThrow();
      await expect(
        updateLibraryMaterial(context.author, {
          id: material.id,
          data: { name: "Bypass" },
        }),
      ).rejects.toThrow();
      await expect(
        setMaterialArchived(context.author, material.id, true),
      ).rejects.toThrow();
      const suggestion = await submitMaterialEdit(context.author, {
        materialId: material.id,
        changes: { ...card, name: "Reviewed name" },
      });
      expect(
        (await db.material.findUniqueOrThrow({ where: { id: material.id } }))
          .name,
      ).toBe(card.name);
      expect(await listMaterialEdits(context.reader)).toEqual([]);
      expect(await listMaterialEdits(context.author)).toHaveLength(1);
      await expect(
        reviewMaterialEdit(context.reader, {
          id: suggestion.id,
          decision: "APPROVED",
        }),
      ).rejects.toThrow();
      await reviewMaterialEdit(context.steward, {
        id: suggestion.id,
        decision: "APPROVED",
      });
      expect(
        (await db.material.findUniqueOrThrow({ where: { id: material.id } }))
          .name,
      ).toBe("Reviewed name");
      expect(
        await db.auditEvent.count({
          where: {
            entityId: suggestion.id,
            action: "library.material.edit_approved",
          },
        }),
      ).toBe(1);
      expect(
        await db.notification.count({
          where: { userId: context.author.uid, kind: "material_edit_approved" },
        }),
      ).toBe(1);
    } finally {
      await context.cleanup();
    }
  });
  it("rolls back stale approvals without overwriting newer facts", async () => {
    const context = await fixture();
    try {
      const material = await saveMaterialCard(context.author, null, card);
      const suggestion = await submitMaterialEdit(context.author, {
        materialId: material.id,
        changes: { ...card, notes: "Suggested" },
      });
      await saveMaterialCard(context.steward, material.id, {
        ...card,
        notes: "Newer fact",
      });
      await expect(
        reviewMaterialEdit(context.steward, {
          id: suggestion.id,
          decision: "APPROVED",
        }),
      ).rejects.toThrow(/changed/);
      expect(
        (
          await db.materialEditSuggestion.findUniqueOrThrow({
            where: { id: suggestion.id },
          })
        ).status,
      ).toBe("PENDING");
      expect(
        await db.auditEvent.count({
          where: {
            entityId: suggestion.id,
            action: "library.material.edit_approved",
          },
        }),
      ).toBe(0);
      await reviewMaterialEdit(context.steward, {
        id: suggestion.id,
        decision: "REJECTED",
      });
      expect(
        (await db.material.findUniqueOrThrow({ where: { id: material.id } }))
          .notes,
      ).toBe("Newer fact");
    } finally {
      await context.cleanup();
    }
  });
  it("applies concurrent review attempts only once", async () => {
    const context = await fixture();
    try {
      const material = await saveMaterialCard(context.author, null, card);
      const suggestion = await submitMaterialEdit(context.author, {
        materialId: material.id,
        changes: { ...card, notes: "Suggested" },
      });
      const attempts = await Promise.allSettled([
        reviewMaterialEdit(context.steward, {
          id: suggestion.id,
          decision: "APPROVED",
        }),
        reviewMaterialEdit(context.admin, {
          id: suggestion.id,
          decision: "APPROVED",
        }),
      ]);
      expect(
        attempts.filter((attempt) => attempt.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        await db.auditEvent.count({
          where: {
            entityId: suggestion.id,
            action: "library.material.edit_approved",
          },
        }),
      ).toBe(1);
    } finally {
      await context.cleanup();
    }
  });
  it("denies cross-organization proposals, reviews and recipe reads", async () => {
    const home = await fixture();
    const foreign = await fixture();
    try {
      const material = await saveMaterialCard(home.author, null, card);
      const suggestion = await submitMaterialEdit(home.author, {
        materialId: material.id,
        changes: card,
      });
      await expect(
        submitMaterialEdit(foreign.author, {
          materialId: material.id,
          changes: card,
        }),
      ).rejects.toThrow();
      await expect(
        reviewMaterialEdit(foreign.admin, {
          id: suggestion.id,
          decision: "APPROVED",
        }),
      ).rejects.toThrow();
      const recipe = await saveRecipe(home.author, {
        id: null,
        data: recipeData,
      });
      await expect(
        reviewRecipe(foreign.admin, { id: recipe.id, decision: "APPROVED" }),
      ).rejects.toThrow();
      expect(await getRecipePayload(foreign.admin, recipe.id)).toBeNull();
      expect(await listMaterialEdits(foreign.admin)).toEqual([]);
    } finally {
      await home.cleanup();
      await foreign.cleanup();
    }
  });
  it("separates creator, approved-content access and recipe stewardship", async () => {
    const context = await fixture();
    try {
      await setUserStewardship(
        context.admin,
        context.reader.uid,
        "recipeAccess",
        true,
      );
      const recipe = await saveRecipe(context.author, {
        id: null,
        data: recipeData,
      });
      expect(recipe.approvalStatus).toBe("PENDING");
      const createdAudit = await db.auditEvent.findFirstOrThrow({
        where: { entityId: recipe.id, action: "library.recipe.created" },
      });
      expect(createdAudit.changes).toEqual({ name: recipe.name });
      expect(await getRecipePayload(context.author, recipe.id)).toMatchObject(
        recipeData.payload,
      );
      expect(await getRecipePayload(context.steward, recipe.id)).toMatchObject(
        recipeData.payload,
      );
      await expect(getRecipePayload(context.reader, recipe.id)).rejects.toThrow(
        /restricted/,
      );
      expect(
        (await getLibraryPageData(context.reader)).recipes.find(
          (row) => row.id === recipe.id,
        ),
      ).toMatchObject({
        name: recipeData.name,
        payload: null,
        summary: "",
        canRead: false,
      });
      await expect(
        saveRecipe(context.author, { id: recipe.id, data: recipeData }),
      ).rejects.toThrow();
      await expect(
        saveRecipe(context.reader, { id: recipe.id, data: recipeData }),
      ).rejects.toThrow();
      await expect(
        setRecipeArchived(context.reader, recipe.id, true),
      ).rejects.toThrow();
      await reviewRecipe(context.steward, {
        id: recipe.id,
        decision: "APPROVED",
      });
      expect(await getRecipePayload(context.reader, recipe.id)).toMatchObject(
        recipeData.payload,
      );
      await expect(
        reviewRecipe(context.steward, { id: recipe.id, decision: "REJECTED" }),
      ).rejects.toThrow();
      expect(
        await db.notification.count({
          where: { userId: context.author.uid, kind: "recipe_approved" },
        }),
      ).toBe(1);
      await setUserStewardship(
        context.admin,
        context.reader.uid,
        "recipeAccess",
        false,
      );
      await expect(
        getRecipePayload(context.reader, recipe.id),
      ).rejects.toThrow();
      expect(await getRecipePayload(context.author, recipe.id)).toMatchObject(
        recipeData.payload,
      );
    } finally {
      await context.cleanup();
    }
  });
  it("keeps rejected recipes private and steward creations approved", async () => {
    const context = await fixture();
    try {
      const pending = await saveRecipe(context.author, {
        id: null,
        data: recipeData,
      });
      await reviewRecipe(context.steward, {
        id: pending.id,
        decision: "REJECTED",
      });
      await setUserStewardship(
        context.admin,
        context.reader.uid,
        "recipeAccess",
        true,
      );
      await expect(
        getRecipePayload(context.reader, pending.id),
      ).rejects.toThrow();
      expect(await getRecipePayload(context.author, pending.id)).toMatchObject(
        recipeData.payload,
      );
      const approved = await saveRecipe(context.steward, {
        id: null,
        data: recipeData,
      });
      expect(approved.approvalStatus).toBe("APPROVED");
      await setUserStewardship(
        context.admin,
        context.steward.uid,
        "recipeSteward",
        false,
      );
      await expect(
        saveRecipe(context.steward, { id: approved.id, data: recipeData }),
      ).rejects.toThrow();
    } finally {
      await context.cleanup();
    }
  });
});
