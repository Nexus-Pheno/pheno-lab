import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { preferredView } from "@/lib/actions/view";
import { HomeBoard } from "@/components/dashboard/HomeBoard";
import { listDashboardExperiments } from "@/modules/experiments/query";

export default async function HomePage() {
  const session = await requireSession();
  // Phones and tablets land on the input portal unless they chose otherwise.
  if ((await preferredView()) === "portal") redirect("/portal");
  const experiments = await listDashboardExperiments(session);

  return (
    <>
      <HomeBoard role={session.role} experiments={experiments} />
    </>
  );
}
