-- Idle-draft housekeeping: warn at 7 idle days, archive at 10, renewable.
ALTER TABLE "Experiment" ADD COLUMN "idleWarnedAt" TIMESTAMP(3);
ALTER TABLE "Experiment" ADD COLUMN "idleArchivedAt" TIMESTAMP(3);
