import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { getT } from "@/lib/i18n/server";
import { IngestReview, type IngestRow } from "@/components/ingest/IngestReview";
import { Icon } from "@/components/ui";
import { getIngestReviewData } from "@/modules/ingest/query";

// Quality gate for ingested data: agents stage extracted facts here and a
// manager/admin reviews, edits and publishes them into the live library.
export default async function IngestPage() {
  const session = await requireSession();
  if (session.role === "TECHNICIAN") notFound();
  const t = await getT();

  const data = await getIngestReviewData(session);
  const rows: IngestRow[] = data.items;

  return (
    <main className="h-full overflow-y-auto bg-subtle">
      <div className="max-w-4xl mx-auto p-3 sm:p-6 space-y-5">
        <div>
          <h1 className="text-lg font-bold flex items-center gap-2">
            <Icon name="Inbox" size={17} className="text-brand-deep" />{" "}
            {t("ing.title")}
          </h1>
          <p className="text-xs text-muted">{t("ing.subtitle")}</p>
        </div>

        <div className="bg-surface border border-line rounded-[6px] p-3.5">
          <h2 className="text-[12.5px] font-bold mb-1">{t("ing.howTitle")}</h2>
          <p className="text-[11.5px] text-muted leading-relaxed">
            {t("ing.howBody")}
          </p>
        </div>

        <IngestReview
          items={rows}
          processNames={data.processNames}
          categories={data.categories}
          materialNames={data.materialNames}
        />
      </div>
    </main>
  );
}
