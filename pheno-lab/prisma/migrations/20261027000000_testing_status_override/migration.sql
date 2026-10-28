-- Expand-only: previous application versions ignore this optional status table.
CREATE TYPE "TestingStatus" AS ENUM ('IN_PROGRESS', 'COMPLETE');

CREATE TABLE "TestingStatusOverride" (
    "experimentId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "requestSetKey" TEXT NOT NULL,
    "status" "TestingStatus" NOT NULL,
    "reason" TEXT NOT NULL,
    "changedById" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TestingStatusOverride_pkey" PRIMARY KEY ("experimentId")
);

CREATE INDEX "TestingStatusOverride_organizationId_idx" ON "TestingStatusOverride"("organizationId");
CREATE INDEX "TestingStatusOverride_changedById_idx" ON "TestingStatusOverride"("changedById");

ALTER TABLE "TestingStatusOverride" ADD CONSTRAINT "TestingStatusOverride_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "Experiment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TestingStatusOverride" ADD CONSTRAINT "TestingStatusOverride_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TestingStatusOverride" ADD CONSTRAINT "TestingStatusOverride_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
