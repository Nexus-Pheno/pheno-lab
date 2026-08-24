import { requireSession } from "@/lib/auth";
import { getT } from "@/lib/i18n/server";
import { ExportLog } from "@/components/data/ExportLog";
import { Icon } from "@/components/ui";
import { listExportRequests } from "@/modules/exports/service";

// The export audit trail. Administrators see every request and decide the
// pending ones; everyone else sees their own history.
export default async function ExportsPage() {
  const session = await requireSession();
  const t = await getT();
  const rows = await listExportRequests(session);

  return (
    <main className="h-full overflow-y-auto bg-subtle">
      <div className="max-w-5xl mx-auto p-3 sm:p-6 space-y-5">
        <div>
          <h1 className="text-lg font-bold flex items-center gap-2">
            <Icon name="Download" size={17} className="text-brand-deep" />{" "}
            {t("exp.title")}
          </h1>
          <p className="text-xs text-muted">
            {session.role === "ADMIN"
              ? t("exp.subtitleAdmin")
              : t("exp.subtitleMine")}
          </p>
        </div>
        <ExportLog rows={rows} isAdmin={session.role === "ADMIN"} />
      </div>
    </main>
  );
}
