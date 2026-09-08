-- Feedback verification loop: implementation patch notes, reporter
-- confirm/dispute, and the 7-day auto-verify timer.
ALTER TABLE "Feedback" ADD COLUMN     "implementedAt" TIMESTAMP(3);
ALTER TABLE "Feedback" ADD COLUMN     "implementationNote" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Feedback" ADD COLUMN     "verifiedAt" TIMESTAMP(3);
ALTER TABLE "Feedback" ADD COLUMN     "verifiedAuto" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Feedback" ADD COLUMN     "disputeNote" TEXT NOT NULL DEFAULT '';
