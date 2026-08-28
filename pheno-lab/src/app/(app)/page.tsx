import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { preferredView } from "@/lib/actions/view";
import { ActivityMonitor } from "@/components/dashboard/ActivityMonitor";
import { HomeBoard } from "@/components/dashboard/HomeBoard";
import { getActivityFeed } from "@/modules/audit/query";
import { listDashboardExperiments } from "@/modules/experiments/query";

export default async function HomePage() {
  const session = await requireSession();
  // Phones and tablets land on the input portal unless they chose otherwise.
  if ((await preferredView()) === "portal") redirect("/portal");
  const [experiments, activity] = await Promise.all([
    listDashboardExperiments(session),
    // The activity monitor is admin-only for now.
    session.role === "ADMIN" ? getActivityFeed(session) : Promise.resolve(null),
  ]);

  return (
    <div className="h-full flex min-h-0">
      {activity && <ActivityMonitor initial={activity} />}
      <div className="flex-1 min-w-0">
        <HomeBoard role={session.role} experiments={experiments} />
      </div>
    </div>
  );
}
