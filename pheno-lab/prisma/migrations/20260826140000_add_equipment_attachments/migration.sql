-- Equipment keeps its original spec sheets, so a machine's documentation lives
-- with the record instead of in someone's downloads folder.
--
-- Expand-only: the column is nullable and the previous release simply ignores
-- it, so the release before this one keeps running if the deploy is rolled
-- back. Nothing is backfilled and no existing row changes.
ALTER TABLE "Attachment" ADD COLUMN "equipmentId" TEXT;

ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "Equipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
