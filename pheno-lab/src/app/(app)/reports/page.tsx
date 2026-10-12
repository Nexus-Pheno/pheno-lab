import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { getLang, getT } from "@/lib/i18n/server";
import { fmtBeijing } from "@/lib/datetime";
import { Icon } from "@/components/ui";
import { listLabReports } from "@/modules/reports/query";

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const actor = await requireSession();
  const [lang, t, params] = await Promise.all([
    getLang(),
    getT(),
    searchParams,
  ]);
  const page = /^\d+$/.test(params.page ?? "")
    ? Math.min(10000, Math.max(1, Number(params.page)))
    : 1;
  const result = await listLabReports(actor, { page });
  return (
    <main className="h-full overflow-y-auto bg-subtle">
      <div className="max-w-5xl mx-auto p-4 sm:p-6">
        <h1 className="text-xl font-bold">{t("reports.title")}</h1>
        <p className="text-sm text-muted mt-2 mb-5">
          {t(result.canOpen ? "reports.intro" : "reports.restricted")}
        </p>
        <div className="bg-surface border border-line rounded-[6px] overflow-hidden">
          <div className="hidden sm:grid grid-cols-[1fr_180px_100px] gap-4 px-5 py-3 bg-subtle border-b border-line text-xs text-muted font-semibold">
            <span>{t("reports.reportTitle")}</span>
            <span>{t("reports.generated")}</span>
            <span>{t("reports.access")}</span>
          </div>
          {result.rows.length === 0 && (
            <p className="p-8 text-sm text-muted">{t("reports.empty")}</p>
          )}
          <ul className="divide-y divide-line">
            {result.rows.map((row) => {
              const title = lang === "zh" ? row.titleZh : row.titleEn;
              const content = (
                <>
                  <span className="font-semibold text-sm break-words">
                    {title}
                  </span>
                  <time
                    dateTime={row.generatedAt}
                    className="text-xs text-muted"
                  >
                    {fmtBeijing(new Date(row.generatedAt))} (UTC+8)
                  </time>
                  <span className="inline-flex items-center gap-1.5 text-xs text-brand-deep">
                    <Icon
                      name={result.canOpen ? "ArrowUpRight" : "LockKeyhole"}
                      size={14}
                    />
                    {t(result.canOpen ? "reports.open" : "reports.locked")}
                  </span>
                </>
              );
              const styles =
                "grid sm:grid-cols-[1fr_180px_100px] gap-2 sm:gap-4 items-center px-4 sm:px-5 py-5";
              return (
                <li key={row.id}>
                  {result.canOpen ? (
                    <Link
                      href={`/reports/${row.id}`}
                      className={`${styles} hover:bg-subtle`}
                    >
                      {content}
                    </Link>
                  ) : (
                    <div className={styles}>{content}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
        {(result.page > 1 || result.page * 20 < result.total) && (
          <nav
            aria-label={t("reports.pages")}
            className="flex gap-4 mt-4 text-sm text-brand-deep"
          >
            {result.page > 1 && (
              <Link href={`/reports?page=${result.page - 1}`}>
                {t("reports.previous")}
              </Link>
            )}
            {result.page * 20 < result.total && (
              <Link href={`/reports?page=${result.page + 1}`}>
                {t("reports.next")}
              </Link>
            )}
          </nav>
        )}
      </div>
    </main>
  );
}
