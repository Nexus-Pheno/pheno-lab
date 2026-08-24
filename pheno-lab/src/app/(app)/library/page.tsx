import { requireSession } from "@/lib/auth";
import {
  ProcessLibrary,
  LocationSection,
  EnvironmentSection,
} from "@/components/library/sections";
import {
  MaterialsSection,
  RecipesSection,
} from "@/components/library/MaterialsRecipes";
import { PresetsSection } from "@/components/library/PresetsSection";
import { getLibraryPageData } from "@/modules/library/query";

export default async function LibraryPage() {
  const session = await requireSession();
  const data = await getLibraryPageData(session);

  return (
    <main className="h-full overflow-y-auto bg-subtle">
      <div className="max-w-5xl mx-auto p-3 sm:p-6 space-y-8">
        <MaterialsSection
          materials={data.materials}
          categories={data.categories.map((c) => ({
            id: c.id,
            code: c.code,
            name: c.name,
            nameZh: c.nameZh,
            builtIn: c.builtIn,
          }))}
          canManage={data.materialAdmin}
        />

        {/* Recipe contents never leave the server without recipeAccess. */}
        <RecipesSection canView={data.recipeAccess} recipes={data.recipes} />

        <ProcessLibrary
          processes={data.processes}
          equipment={data.equipment}
          locations={data.locations}
          canEdit={data.canEdit}
          canEditEquipment={data.stewardships.equipmentAdmin}
          canAddLocation={data.stewardships.facilityAdmin}
          layers={data.layers}
        />
        <EnvironmentSection
          environments={data.environments}
          canEdit={data.stewardships.facilityAdmin}
        />
        <LocationSection
          locations={data.locations}
          canEdit={data.stewardships.facilityAdmin}
        />

        <PresetsSection
          presets={data.presets}
          sessionUid={session.uid}
          sessionRole={session.role}
        />
      </div>
    </main>
  );
}
