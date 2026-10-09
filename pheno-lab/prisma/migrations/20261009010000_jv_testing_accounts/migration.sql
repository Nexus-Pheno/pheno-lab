-- AlterTable
ALTER TABLE "User" ADD COLUMN     "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sessionVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "temporaryPasswordExpiresAt" TIMESTAMP(3),
ADD COLUMN     "testingOnly" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "AccountHandoff" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "recipientIds" TEXT[],
    "encryptedPassword" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountHandoff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestingRequest" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "experimentId" TEXT NOT NULL,
    "characterizationId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "sampleIds" TEXT[],
    "photoPath" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "requestKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TestingRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccountHandoff_targetUserId_idx" ON "AccountHandoff"("targetUserId");

-- CreateIndex
CREATE INDEX "TestingRequest_organizationId_createdAt_idx" ON "TestingRequest"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "TestingRequest_experimentId_idx" ON "TestingRequest"("experimentId");

-- CreateIndex
CREATE UNIQUE INDEX "TestingRequest_organizationId_requestKey_key" ON "TestingRequest"("organizationId", "requestKey");

-- AddForeignKey
ALTER TABLE "AccountHandoff" ADD CONSTRAINT "AccountHandoff_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountHandoff" ADD CONSTRAINT "AccountHandoff_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestingRequest" ADD CONSTRAINT "TestingRequest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestingRequest" ADD CONSTRAINT "TestingRequest_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "Experiment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestingRequest" ADD CONSTRAINT "TestingRequest_characterizationId_fkey" FOREIGN KEY ("characterizationId") REFERENCES "Characterization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestingRequest" ADD CONSTRAINT "TestingRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestingRequest" ADD CONSTRAINT "TestingRequest_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
