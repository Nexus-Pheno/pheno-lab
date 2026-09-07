-- NFC badge tap-login on shared tablets. Additive only.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "badgeUid" TEXT,
ADD COLUMN "badgeSecretHash" TEXT NOT NULL DEFAULT '',
ADD COLUMN "badgeBoundAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "User_badgeUid_key" ON "User"("badgeUid");
