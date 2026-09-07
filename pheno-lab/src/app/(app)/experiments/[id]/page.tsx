import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import Designer from "@/components/designer/Designer";
import { RequestAccess } from "@/components/experiments/RequestAccess";
import { AccessRequestsBanner } from "@/components/experiments/AccessRequestsBanner";
import { getExperimentDesignerData } from "@/modules/experiments/query";
import {
  getExperimentPeek,
  listOpenRequests,
} from "@/modules/experiments/access-request-service";

export default async function ExperimentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireSession();

  const data = await getExperimentDesignerData(session, id);
  if (!data) {
    // Exists in this lab but is not theirs to open: knock on the door.
    const peek = await getExperimentPeek(session, id);
    if (!peek) notFound();
    return <RequestAccess experiment={peek} />;
  }

  // Whoever can edit also answers the knocks.
  const openRequests = data.canEdit
    ? await listOpenRequests(session, id).catch(() => [])
    : [];

  return (
    <div className="h-full flex flex-col min-h-0">
      {openRequests.length > 0 && (
        <AccessRequestsBanner experimentId={id} requests={openRequests} />
      )}
      <div className="flex-1 min-h-0">
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
      sessionUid={session.uid}
    />
      </div>
    </div>
  );
}
