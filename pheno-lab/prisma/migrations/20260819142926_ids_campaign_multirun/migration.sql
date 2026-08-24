-- AlterTable
ALTER TABLE "CharacterizationResult" ADD COLUMN     "runId" TEXT;

-- AlterTable
ALTER TABLE "Experiment" ADD COLUMN     "campaign" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "orgNumber" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "nextExpSeq" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "userNumber" INTEGER NOT NULL DEFAULT 0;

-- AddForeignKey
ALTER TABLE "CharacterizationResult" ADD CONSTRAINT "CharacterizationResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE SET NULL ON UPDATE CASCADE;
