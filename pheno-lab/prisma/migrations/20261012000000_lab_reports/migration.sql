-- Expand only. A role never grants report access implicitly.
ALTER TABLE "User" ADD COLUMN "reportAccess" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "LabReport" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "publicationKey" TEXT NOT NULL,
    "titleEn" TEXT NOT NULL,
    "titleZh" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "storedPath" TEXT NOT NULL,
    "contentSha256" TEXT NOT NULL,
    "contentBytes" INTEGER NOT NULL,
    "recipientIds" TEXT[] NOT NULL,
    CONSTRAINT "LabReport_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LabReport_storedPath_key" ON "LabReport"("storedPath");
CREATE UNIQUE INDEX "LabReport_organizationId_publicationKey_key" ON "LabReport"("organizationId", "publicationKey");
CREATE INDEX "LabReport_organizationId_generatedAt_id_idx" ON "LabReport"("organizationId", "generatedAt", "id");
ALTER TABLE "LabReport" ADD CONSTRAINT "LabReport_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
