import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { getT } from "@/lib/i18n/server";
import { IngestReview, type IngestRow } from "@/components/ingest/IngestReview";
import { Icon } from "@/components/ui";

// Quality gate for ingested data: agents stage extracted facts here and a
// manager/admin reviews, edits and publishes them into the live library.
export default async function IngestPage() {
  const session = await requireSession();
  if (session.role === "TECHNICIAN") notFound();
  const t = await getT();

  const [items, processes, categories, materials] = await Promise.all([
    // Payloads are fetched per item when the reviewer opens one — an imported
    // experiment carries hundreds of samples, and shipping every payload to
    // the browser makes this page unusable at real volume.
    db.ingestItem.findMany({
      where: { organizationId: session.org },
      orderBy: [{ createdAt: "desc" }],
      select: {
        id: true, kind: true, status: true, title: true, sourceFile: true,
        confidence: true, reviewNote: true, publishedId: true,
        createdAt: true, reviewedAt: true,
        reviewedBy: { select: { name: true } },
      },
      take: 2000,
    }),
    db.process.findMany({
      where: { organizationId: session.org, archived: false },
      orderBy: { position: "asc" },
      select: { name: true },
    }),
    db.materialCategoryDef.findMany({
      where: { organizationId: session.org },
      orderBy: { position: "asc" },
      select: { code: true, name: true },
    }),
    // Names only — used to flag what a staged formula would introduce.
    db.material.findMany({
      where: { organizationId: session.org, archived: false },
      select: { name: true },
    }),
  ]);

  const rows: IngestRow[] = items.map((i) => ({
    id: i.id,
    kind: i.kind,
    status: i.status,
    title: i.title,
    sourceFile: i.sourceFile,
    confidence: i.confidence,
    reviewNote: i.reviewNote,
    createdAt: i.createdAt.toISOString().slice(0, 10),
    reviewedAt: i.reviewedAt ? i.reviewedAt.toISOString().slice(0, 10) : null,
    reviewedBy: i.reviewedBy?.name ?? null,
  }));

  return (
    <main className="h-full overflow-y-auto bg-subtle">
      <div className="max-w-4xl mx-auto p-3 sm:p-6 space-y-5">
        <div>
          <h1 className="text-lg font-bold flex items-center gap-2">
            <Icon name="Inbox" size={17} className="text-brand-deep" /> {t("ing.title")}
          </h1>
          <p className="text-xs text-muted">{t("ing.subtitle")}</p>
        </div>

        <div className="bg-surface border border-line rounded-[6px] p-3.5">
          <h2 className="text-[12.5px] font-bold mb-1">{t("ing.howTitle")}</h2>
          <p className="text-[11.5px] text-muted leading-relaxed">{t("ing.howBody")}</p>
        </div>

        <IngestReview
          items={rows}
          processNames={processes.map((p) => p.name)}
          categories={categories}
          materialNames={materials.map((m) => m.name)}
        />
      </div>
    </main>
  );
}
