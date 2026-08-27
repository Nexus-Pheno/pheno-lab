import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import Designer from "@/components/designer/Designer";
import { getExperimentDesignerData } from "@/modules/experiments/query";

export default async function ExperimentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireSession();

  const data = await getExperimentDesignerData(session, id);
  if (!data) notFound();

  return (
    <Designer
      initial={data.experiment}
      processes={data.processes}
      equipment={data.equipment}
      materials={data.materials}
      environments={data.environments}
      presets={data.presets}
      orgUsers={data.orgUsers}
      recipes={data.recipes}
      layers={data.layers}
      categoryLayers={data.categoryLayers}
      canManageMaterials={data.canManageMaterials}
      canEdit={data.canEdit}
      canManageMembers={data.canEdit}
    />
  );
}
