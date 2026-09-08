-- Recycle bin: deleting an experiment trashes it (deletedAt) instead of
-- destroying it; trashed rows hide from every scope and purge after ~30 days.
ALTER TABLE "Experiment" ADD COLUMN     "deletedAt" TIMESTAMP(3);
ALTER TABLE "Experiment" ADD COLUMN     "deletedById" TEXT;

CREATE INDEX "Experiment_organizationId_deletedAt_idx" ON "Experiment"("organizationId", "deletedAt");

ALTER TABLE "Experiment" ADD CONSTRAINT "Experiment_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
