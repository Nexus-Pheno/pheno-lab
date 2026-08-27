-- A J-V scan that no sample explains still belongs to somebody: either the
-- operator whose name the instrument recorded, or whoever a manager hands it
-- to. Without this, unattached scans had no owner and were visible to the whole
-- organization.
--
-- Expand-only: nullable column, no backfill, previous release ignores it.
ALTER TABLE "JvMeasurement" ADD COLUMN "assignedToId" TEXT;

ALTER TABLE "JvMeasurement" ADD CONSTRAINT "JvMeasurement_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The instruments page filters on this for every non-admin viewer.
CREATE INDEX "JvMeasurement_assignedToId_idx" ON "JvMeasurement"("assignedToId");
