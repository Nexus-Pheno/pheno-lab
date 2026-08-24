import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { hasMaterialAdmin, hasRecipeAccess } from "@/lib/actions/materials";
import { mySteward } from "@/lib/actions/stewardship";
import type { RecipePayload } from "@/lib/materials-meta";
import { ProcessLibrary, LocationSection, EnvironmentSection } from "@/components/library/sections";
import { MaterialsSection, RecipesSection } from "@/components/library/MaterialsRecipes";
import { PresetsSection } from "@/components/library/PresetsSection";

export default async function LibraryPage() {
  const session = await requireSession();
  const canEdit = session.role !== "TECHNICIAN";
  const orgWhere = { organizationId: session.org };
  const [processes, equipment, materials, locations, environments, presets, recipes, categories, matAdmin, recAccess, steward, layers] =
    await Promise.all([
      db.process.findMany({ where: orgWhere, orderBy: [{ archived: "asc" }, { position: "asc" }] }),
      db.equipment.findMany({ where: orgWhere, orderBy: [{ archived: "asc" }, { name: "asc" }] }),
      db.material.findMany({ where: orgWhere, orderBy: [{ archived: "asc" }, { name: "asc" }] }),
      db.location.findMany({ where: orgWhere, orderBy: { name: "asc" } }),
      db.labEnvironment.findMany({ where: orgWhere, orderBy: [{ archived: "asc" }, { name: "asc" }] }),
      db.preset.findMany({
        where: orgWhere,
        orderBy: { usageCount: "desc" },
        include: { createdBy: { select: { name: true } }, process: { select: { name: true } } },
      }),
      db.recipe.findMany({ where: orgWhere, orderBy: { name: "asc" } }),
      db.materialCategoryDef.findMany({ where: orgWhere, orderBy: { position: "asc" } }),
      hasMaterialAdmin(),
      hasRecipeAccess(),
      mySteward(),
      db.deviceLayer.findMany({ where: orgWhere, orderBy: { position: "asc" }, select: { code: true, name: true } }),
    ]);

  return (
    <main className="h-full overflow-y-auto bg-subtle">
      <div className="max-w-5xl mx-auto p-3 sm:p-6 space-y-8">
        <MaterialsSection
          materials={materials}
          categories={categories.map((c) => ({ id: c.id, code: c.code, name: c.name, nameZh: c.nameZh, builtIn: c.builtIn }))}
          canManage={matAdmin}
        />

        {/* Recipe contents never leave the server without recipeAccess. */}
        <RecipesSection
          canView={recAccess}
          recipes={recipes.map((r) => ({
            id: r.id,
            name: r.name,
            summary: r.summary,
            archived: r.archived,
            payload: recAccess ? ((r.payload as RecipePayload | null) ?? null) : null,
          }))}
        />

        <ProcessLibrary
          processes={processes}
          equipment={equipment}
          locations={locations}
          canEdit={canEdit}
          canEditEquipment={steward.equipmentAdmin}
          canAddLocation={steward.facilityAdmin}
          layers={layers}
        />
        <EnvironmentSection environments={environments} canEdit={steward.facilityAdmin} />
        <LocationSection locations={locations} canEdit={steward.facilityAdmin} />

        <PresetsSection presets={presets} sessionUid={session.uid} sessionRole={session.role} />
      </div>
    </main>
  );
}
