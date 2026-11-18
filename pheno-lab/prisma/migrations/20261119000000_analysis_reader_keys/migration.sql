-- Additive only. No accounts are granted access and no existing records change.
CREATE TABLE "ResearchReaderKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "organizationId" TEXT NOT NULL,
    "sessionVersion" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "reports" BOOLEAN NOT NULL DEFAULT false,
    "chemistry" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "ResearchReaderKey_digest_key" ON "ResearchReaderKey"("digest");
CREATE INDEX "ResearchReaderKey_userId_organizationId_idx" ON "ResearchReaderKey"("userId","organizationId");
