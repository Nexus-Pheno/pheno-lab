import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { getLang, getT } from "@/lib/i18n/server";
import { fmtBeijing } from "@/lib/datetime";
import { AuthorizationError } from "@/modules/authorization/policy";
import { getLabReportMetadata } from "@/modules/reports/query";

export default async function ReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const actor = await requireSession();
  const { id } = await params;
  const [lang, t] = await Promise.all([getLang(), getT()]);
  const report = await getLabReportMetadata(actor, id).catch((error) => {
    if (error instanceof AuthorizationError) notFound();
    throw error;
  });
  if (!report) notFound();
  const title = lang === "zh" ? report.titleZh : report.titleEn;
  return (
    <main className="h-full flex flex-col bg-subtle">
      <div className="shrink-0 border-b border-line bg-surface px-4 py-3 flex flex-wrap gap-x-4 gap-y-2 items-center">
        <Link href="/reports" className="text-sm text-brand-deep font-semibold">
          ← {t("reports.title")}
        </Link>
        <h1 className="text-sm font-semibold flex-1 min-w-0 break-words">
          {title}
        </h1>
        <span className="text-xs text-muted">
          {t("reports.generated")}: {fmtBeijing(new Date(report.generatedAt))}{" "}
          (UTC+8)
        </span>
      </div>
      <iframe
        title={title}
        src={`/api/reports/${report.id}/content#lang=${lang}`}
        sandbox="allow-scripts allow-modals allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        className="w-full flex-1 min-h-0 border-0 bg-white"
      />
    </main>
  );
}
