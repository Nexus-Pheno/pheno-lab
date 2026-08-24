import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { canViewWhere } from "@/lib/actions/experiments";
import { preferredView } from "@/lib/actions/view";
import { HomeBoard } from "@/components/dashboard/HomeBoard";

export default async function HomePage() {
  const session = await requireSession();
  // Phones and tablets land on the input portal unless they chose otherwise.
  if ((await preferredView()) === "portal") redirect("/portal");
  const experiments = await db.experiment.findMany({
    where: await canViewWhere(session),
    orderBy: { updatedAt: "desc" },
    include: {
      createdBy: { select: { name: true } },
      members: { include: { user: { select: { name: true } } } },
      labels: { include: { label: true } },
      _count: { select: { samples: true, steps: true, characterizations: true } },
    },
  });

  return (
    <>
      <HomeBoard
      role={session.role}
      experiments={experiments.map((e) => ({
        id: e.id,
        code: e.code,
        title: e.title,
        status: e.status,
        createdBy: e.createdBy.name,
        members: e.members.map((m) => m.user.name),
        labels: e.labels.map((l) => l.label.name),
        campaign: e.campaign,
        samples: e._count.samples,
        steps: e._count.steps,
        characterizations: e._count.characterizations,
        updatedAt: e.updatedAt.toISOString().slice(0, 10),
      }))}
      />
    </>
  );
}
