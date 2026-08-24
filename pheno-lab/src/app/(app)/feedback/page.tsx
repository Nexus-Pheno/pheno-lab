import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { getT } from "@/lib/i18n/server";
import { FeedbackList } from "@/components/profile/FeedbackList";
import { listFeedback } from "@/modules/accounts/query";

export default async function FeedbackAdminPage() {
  const session = await requireSession();
  if (session.role !== "ADMIN") notFound();
  const t = await getT();

  const feedback = await listFeedback(session);

  return (
    <main className="h-full overflow-y-auto bg-subtle">
      <div className="max-w-4xl mx-auto p-6">
        <div className="flex items-end justify-between mb-4">
          <div>
            <h1 className="text-lg font-bold">{t("fb.adminTitle")}</h1>
            <p className="text-xs text-muted">{t("fb.adminHint")}</p>
          </div>
          <a
            href="/api/feedback-export"
            className="bg-ink text-white rounded-[4px] px-3.5 py-1.5 text-[12px] font-semibold"
          >
            {t("fb.exportJson")}
          </a>
        </div>
        <FeedbackList
          items={feedback.map((f) => ({
            id: f.id,
            kind: f.kind,
            message: f.message,
            screenshotPath: f.screenshotPath,
            errorLog: f.errorLog,
            pageUrl: f.pageUrl,
            userAgent: f.userAgent,
            status: f.status,
            createdAt: f.createdAt.toISOString().replace("T", " ").slice(0, 16),
            userName: f.user.name,
            userEmail: f.user.email,
          }))}
        />
      </div>
    </main>
  );
}
