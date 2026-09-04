-- Feedback portal v2: per-problem titles, an admin review pipeline
-- (approve / reject / implement + comments), and multi-screenshot
-- attachments. All additive.
ALTER TABLE "Feedback" ADD COLUMN "title" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Feedback" ADD COLUMN "adminNote" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Feedback" ADD COLUMN "reviewedById" TEXT;
ALTER TABLE "Feedback" ADD COLUMN "reviewedAt" TIMESTAMP(3);
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_reviewedById_fkey"
  FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Attachment" ADD COLUMN "feedbackId" TEXT;
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_feedbackId_fkey"
  FOREIGN KEY ("feedbackId") REFERENCES "Feedback"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "Attachment_feedbackId_idx" ON "Attachment"("feedbackId");
