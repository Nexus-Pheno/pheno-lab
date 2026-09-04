import { requireSession } from "@/lib/auth";
import { getT } from "@/lib/i18n/server";
import { FeedbackBoard } from "@/components/feedback/FeedbackBoard";
import { listFeedback, listMyFeedback } from "@/modules/accounts/query";

// The feedback pipeline: everyone files problems here (one per item, with
// screenshots); the admin sifts, comments and approves; approved items are
// the implementation queue an agent works from.
export default async function FeedbackPage() {
  const session = await requireSession();
  const isAdmin = session.role === "ADMIN";
  const t = await getT();

  const feedback = isAdmin
    ? await listFeedback(session)
    : await listMyFeedback(session);

  return (
    <main className="h-full overflow-y-auto bg-subtle">
      <div className="max-w-4xl mx-auto p-4 sm:p-6">
        <div className="flex items-end justify-between mb-4 gap-3">
          <div>
            <h1 className="text-lg font-bold">
              {t(isAdmin ? "fb.adminTitle" : "fb.boardTitle")}
            </h1>
            <p className="text-xs text-muted">
              {t(isAdmin ? "fb.adminHint" : "fb.boardHint")}
            </p>
          </div>
          {isAdmin && (
            <a
              href="/api/feedback-export"
              className="bg-ink text-white rounded-[4px] px-3.5 py-1.5 text-[12px] font-semibold shrink-0"
            >
              {t("fb.exportJson")}
            </a>
          )}
        </div>
        <FeedbackBoard
          isAdmin={isAdmin}
          items={feedback.map((f) => ({
            id: f.id,
            kind: f.kind,
            title: f.title,
            message: f.message,
            screenshotPath: f.screenshotPath,
            attachments: f.attachments,
            errorLog: f.errorLog,
            pageUrl: f.pageUrl,
            status: f.status,
            adminNote: f.adminNote,
            reviewedBy: f.reviewedBy?.name ?? "",
            createdAt: f.createdAt.toISOString().replace("T", " ").slice(0, 16),
            userName: f.user.name,
            userEmail: f.user.email,
          }))}
        />
      </div>
    </main>
  );
}
