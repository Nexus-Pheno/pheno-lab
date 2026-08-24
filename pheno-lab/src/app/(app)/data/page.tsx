import { requireSession } from "@/lib/auth";
import { loadDataPage } from "@/modules/data/query";
import { DataTable } from "@/components/data/DataTable";
import { DatabaseSummaryBar } from "@/components/dashboard/DatabaseSummary";
import { experimentVisibilityScope } from "@/modules/authorization/scope";
import { getDatabaseSummary } from "@/modules/insights/query";

// The data table flattens every experiment into one row per sample, with all
// parameters resolved for that sample's variation group — tagged, cleaned,
// AI-ready. It is paged: the lab holds tens of thousands of samples, and
// rendering them all at once froze the browser.

const PER_PAGE = 10; // experiments per page (a page carries all their samples)

export default async function DataPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; q?: string }>;
}) {
  const { page: pageParam, q } = await searchParams;
  const session = await requireSession();
  const page = Math.max(1, Number(pageParam) || 1);
  const query = (q ?? "").slice(0, 120);

  const [data, summary] = await Promise.all([
    loadDataPage(experimentVisibilityScope(session), {
      page,
      perPage: PER_PAGE,
      q: query,
    }),
    getDatabaseSummary(session),
  ]);

  // The layout gives this route a fixed-height slot, so the summary sits in
  // its own band and the table takes the remaining space and scrolls inside.
  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="shrink-0 px-5 pt-3">
        <DatabaseSummaryBar summary={summary} />
      </div>
      <div className="flex-1 min-h-0">
        <DataTable
          columns={data.columns}
          rows={data.rows}
          total={data.total}
          page={data.page}
          perPage={PER_PAGE}
          query={query}
          canExportDirectly={session.role === "ADMIN"}
        />
      </div>
    </div>
  );
}
