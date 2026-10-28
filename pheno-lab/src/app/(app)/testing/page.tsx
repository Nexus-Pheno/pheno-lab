import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { getT } from "@/lib/i18n/server";
import { listTestingExperiments } from "@/modules/testing/query";
import { TestingRefresh } from "@/components/testing/TestingRefresh";
import { TestingStatusEditor } from "@/components/testing/TestingStatusEditor";
import { TestingStatusNote } from "@/components/testing/TestingStatusNote";
import { TestingCompletion } from "@/components/testing/TestingCompletion";
import { fmtBeijing } from "@/lib/datetime";

export default async function TestingPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const session = await requireSession("testing");
  const t = await getT();
  const search = await searchParams;
  const data = await listTestingExperiments(session, {
    q: search.q ?? "",
    page: search.page ?? 1,
  });
  const pageHref = (page: number) =>
    `/testing?${new URLSearchParams({ q: data.q, page: String(page) })}`;
  return (
    <main className="h-full overflow-y-auto bg-subtle p-4 sm:p-6">
      <div className="max-w-5xl mx-auto space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-xl font-bold">{t("testing.title")}</h1>
          <TestingRefresh />
        </div>
        <p className="text-sm text-muted">
          {t(
            data.canSetStatus
              ? "testing.status.workspaceHint"
              : "testing.readOnlyHint",
          )}
        </p>
        {data.recentRequests.length > 0 && (
          <section className="bg-surface border border-brand/40 rounded-lg p-4">
            <h2 className="font-bold mb-3">{t("testing.requests")}</h2>
            <div className="space-y-2">
              {data.recentRequests.map((request) => (
                <div key={request.experimentId}>
                  <Link
                    href={`/testing/${request.experimentId}#request-${request.id}`}
                    data-testing-request-experiment={request.experimentId}
                    className={
                      "block rounded-lg border p-3 " +
                      (request.complete
                        ? "border-emerald-200 bg-emerald-50/60"
                        : "border-line")
                    }
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <b className="text-sm font-mono">{request.code}</b>
                      <TestingCompletion complete={request.complete} t={t} />
                    </div>
                    <p className="text-sm break-words mt-1">
                      {t("testing.requestedBy")}:{" "}
                      {request.requesters.join(" · ") ||
                        t("testing.unknownRequester")}
                    </p>
                    <p className="text-xs font-mono break-words mt-1">
                      {request.samples
                        .map((s) => s.simCode || s.code)
                        .join(" · ")}
                    </p>
                    <p className="text-xs text-muted mt-1">
                      {t("testing.submissions")}: {request.submissionCount} ·{" "}
                      {t("testing.latestSubmission")}:{" "}
                      {fmtBeijing(new Date(request.createdAt))}
                    </p>
                    <TestingStatusNote
                      manual={request.manual}
                      automaticComplete={request.automaticComplete}
                      t={t}
                    />
                  </Link>
                  {data.canSetStatus && request.requestSetKey && (
                    <TestingStatusEditor
                      key={request.requestSetKey}
                      experimentId={request.experimentId}
                      requestSetKey={request.requestSetKey}
                    />
                  )}
                </div>
              ))}
            </div>
          </section>
        )}
        <form className="flex gap-2">
          <input
            name="q"
            defaultValue={data.q}
            placeholder={t("testing.searchPlaceholder")}
            aria-label={t("testing.searchPlaceholder")}
            maxLength={100}
            className="min-w-0 flex-1 border border-line bg-surface rounded px-3 py-2"
          />
          <button className="bg-ink text-white rounded px-4 py-2">
            {t("testing.search")}
          </button>
        </form>
        <p className="text-xs text-muted">
          {data.total} {t("testing.experiments")}
        </p>
        <div className="space-y-3">
          {data.rows.map((row) => (
            <Link
              key={row.id}
              href={`/testing/${row.id}`}
              className="block bg-surface border border-line rounded-lg p-4 hover:border-brand"
            >
              <div className="flex flex-wrap justify-between gap-2">
                <h2 className="font-mono font-bold">{row.code}</h2>
                <span className="text-xs text-muted">
                  {t("testing.scans")}: {row.measurements} ·{" "}
                  {t("testing.submissions")}: {row.requests}
                </span>
                {row.requests > 0 && (
                  <TestingCompletion complete={row.complete} t={t} />
                )}
              </div>
              {row.requests > 0 && (
                <TestingStatusNote
                  manual={row.manual}
                  automaticComplete={row.automaticComplete}
                  t={t}
                />
              )}
              <p className="text-sm mt-2 break-words">
                {row.samples
                  .slice(0, 24)
                  .map((s) => s.simCode || `${row.code}-${s.code}`)
                  .join(" · ")}
                {row.samples.length > 24
                  ? ` … (+${row.samples.length - 24})`
                  : ""}
              </p>
              <p className="text-xs text-muted mt-2">
                {row.updatedAt
                  ? `${t("testing.lastUpdate")}: ${fmtBeijing(new Date(row.updatedAt))}`
                  : t(row.complete ? "testing.noScans" : "testing.waiting")}
              </p>
            </Link>
          ))}
        </div>
        {!data.rows.length && (
          <p className="p-8 text-center text-muted">{t("testing.empty")}</p>
        )}
        <div className="flex justify-between text-sm">
          {data.page > 1 ? (
            <Link href={pageHref(data.page - 1)}>{t("testing.previous")}</Link>
          ) : (
            <span />
          )}
          {data.page * 25 < data.total && (
            <Link href={pageHref(data.page + 1)}>{t("testing.next")}</Link>
          )}
        </div>
      </div>
    </main>
  );
}
