import { requireSession } from "@/lib/auth";
import { getT } from "@/lib/i18n/server";
import { Icon } from "@/components/ui";
import { TrashView } from "@/components/dashboard/TrashView";
import { listTrash } from "@/modules/experiments/trash-service";

// The recycle bin: deleted experiments wait here ~30 days before purge.
// Everyone sees what they could restore; staff see the whole org's bin.
export default async function TrashPage() {
  const session = await requireSession();
  const rows = await listTrash(session);
  const t = await getT();

  return (
    <main className="h-full overflow-y-auto bg-subtle">
      <div className="max-w-4xl mx-auto p-3 sm:p-6 space-y-5">
        <div>
          <h1 className="text-lg font-bold flex items-center gap-2">
            <Icon name="Trash2" size={18} className="text-charcoal" />
            {t("trash.title")}
          </h1>
          <p className="text-[12.5px] text-muted mt-0.5">
            {t("trash.subtitle")}
          </p>
        </div>
        <TrashView rows={rows} staff={session.role !== "TECHNICIAN"} />
      </div>
    </main>
  );
}
