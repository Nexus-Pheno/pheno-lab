import { requireSession } from "@/lib/auth";
import { getT } from "@/lib/i18n/server";
import { Icon } from "@/components/ui";
import { InstrumentsView } from "@/components/instruments/InstrumentsView";
import { getInstrumentsPageData } from "@/modules/instruments/query";

// Where instrument data lands: what the simulators have pushed, what matched a
// sample, and what still needs a human. Files arrive on their own — nothing on
// this page has to be run for ingestion to happen.
export default async function InstrumentsPage() {
  const session = await requireSession();
  const t = await getT();

  const data = await getInstrumentsPageData(session);

  return (
    <main className="h-full overflow-y-auto bg-subtle">
      <div className="max-w-5xl mx-auto p-3 sm:p-6 space-y-5">
        <div>
          <h1 className="text-lg font-bold flex items-center gap-2">
            <Icon name="Radio" size={17} className="text-brand-deep" />{" "}
            {t("inst.title")}
          </h1>
          <p className="text-xs text-muted">{t("inst.subtitle")}</p>
        </div>
        <InstrumentsView
          rigs={data.rigs}
          matched={data.matched}
          unmatched={data.unmatched}
          samples={data.samples}
          people={data.people}
          canManage={session.role !== "TECHNICIAN"}
        />
      </div>
    </main>
  );
}
