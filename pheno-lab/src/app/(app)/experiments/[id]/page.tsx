import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { experimentInclude } from "@/lib/types";
import Designer from "@/components/designer/Designer";
import { hasMaterialAdmin } from "@/lib/actions/materials";

export default async function ExperimentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireSession();

  const [experiment, processes, equipment, materials, environments, presets, orgUsers, recipes, canManageMaterials, layers] = await Promise.all([
    db.experiment.findUnique({ where: { id }, include: experimentInclude }),
    db.process.findMany({ where: { organizationId: session.org, archived: false }, orderBy: { position: "asc" } }),
    db.equipment.findMany({ where: { organizationId: session.org, archived: false }, orderBy: { name: "asc" } }),
    db.material.findMany({ where: { organizationId: session.org, archived: false }, orderBy: { name: "asc" } }),
    db.labEnvironment.findMany({ where: { organizationId: session.org, archived: false }, orderBy: { name: "asc" } }),
    db.preset.findMany({ where: { organizationId: session.org }, orderBy: { usageCount: "desc" } }),
    db.user.findMany({
      where: { organizationId: session.org },
      select: { id: true, name: true, email: true, role: true },
      orderBy: { name: "asc" },
    }),
    db.recipe.findMany({
      where: { organizationId: session.org, archived: false },
      select: { id: true, name: true, summary: true },
      orderBy: { name: "asc" },
    }),
    hasMaterialAdmin(),
    db.deviceLayer.findMany({
      where: { organizationId: session.org },
      orderBy: { position: "asc" },
      select: { code: true, name: true, nameZh: true },
    }),
  ]);

  if (!experiment || experiment.organizationId !== session.org) notFound();

  const isMember = experiment.members.some((m) => m.userId === session.uid);
  const isCreator = experiment.createdById === session.uid;

  // View access: admin sees all; managers and technicians must be involved.
  if (session.role !== "ADMIN" && !isMember && !isCreator) notFound();

  const canEdit =
    session.role === "ADMIN" || (session.role === "MANAGER" && (isCreator || isMember));

  return (
    <Designer
      initial={experiment}
      processes={processes}
      equipment={equipment}
      materials={materials}
      environments={environments}
      presets={presets}
      orgUsers={orgUsers}
      recipes={recipes}
      layers={layers}
      canManageMaterials={canManageMaterials}
      canEdit={canEdit}
      canManageMembers={canEdit}
    />
  );
}
