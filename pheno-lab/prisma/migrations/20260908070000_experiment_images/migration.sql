-- Images on science fields and discussion comments (Tyler's feedback).
ALTER TABLE "Attachment" ADD COLUMN "experimentId" TEXT;
ALTER TABLE "Attachment" ADD COLUMN "context" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Attachment" ADD COLUMN "commentId" TEXT;

ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "Experiment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "ExperimentComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "Attachment_experimentId_context_idx" ON "Attachment"("experimentId", "context");
CREATE INDEX "Attachment_commentId_idx" ON "Attachment"("commentId");
