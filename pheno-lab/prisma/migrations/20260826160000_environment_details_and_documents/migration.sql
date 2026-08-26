-- A lab environment can now carry free-text detail about the enclosure itself
-- (make, model, chamber layout) and its original manuals. `conditions` stays
-- what it always was: the readings an operator records per run.
--
-- Expand-only. `notes` is NOT NULL with a default so existing rows fill in
-- without a backfill, and `labEnvironmentId` is nullable. The previous release
-- ignores both columns, so a rollback keeps running.
ALTER TABLE "LabEnvironment" ADD COLUMN "notes" TEXT NOT NULL DEFAULT '';

ALTER TABLE "Attachment" ADD COLUMN "labEnvironmentId" TEXT;

ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_labEnvironmentId_fkey" FOREIGN KEY ("labEnvironmentId") REFERENCES "LabEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
