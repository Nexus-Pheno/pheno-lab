import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { getT } from "@/lib/i18n/server";
import { TestDataView } from "@/components/dashboard/TestDataView";
import { Icon } from "@/components/ui";
import { listTestExperiments } from "@/modules/experiments/service";

// Everything created in test mode, kept out of every real view and clearable
// in one action. Staff only — technicians never see the test space.
export default async function TestDataPage() {
  const session = await requireSession();
  if (session.role === "TECHNICIAN") notFound();
  const t = await getT();
  const rows = await listTestExperiments(session);

  return (
    <main className="h-full overflow-y-auto bg-subtle">
      <div className="max-w-4xl mx-auto p-3 sm:p-6 space-y-5">
        <div>
          <h1 className="text-lg font-bold flex items-center gap-2">
            <Icon name="FlaskConical" size={17} className="text-warn" />{" "}
            {t("test.title")}
          </h1>
          <p className="text-xs text-muted">{t("test.subtitle")}</p>
        </div>

        <TestDataView
          isAdmin={session.role === "ADMIN"}
          rows={rows.map((r) => ({
            id: r.id,
            code: r.code,
            title: r.title,
            status: r.status,
            createdBy: r.createdBy?.name ?? "",
            createdAt: r.createdAt.toISOString().slice(0, 10),
            samples: r._count.samples,
            steps: r._count.steps,
            runs: r._count.runs,
          }))}
        />
      </div>
    </main>
  );
}
