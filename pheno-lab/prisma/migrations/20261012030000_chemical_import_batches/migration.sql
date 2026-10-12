CREATE TABLE "ChemicalImportBatch" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "sourcePath" TEXT NOT NULL,
  "sourceSha256" TEXT NOT NULL,
  "sourceBytes" INTEGER NOT NULL,
  "rowCount" INTEGER NOT NULL,
  "manifest" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChemicalImportBatch_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ChemicalImportBatch_sourcePath_key" ON "ChemicalImportBatch"("sourcePath");
CREATE INDEX "ChemicalImportBatch_organizationId_createdAt_idx" ON "ChemicalImportBatch"("organizationId", "createdAt");
ALTER TABLE "ChemicalImportBatch" ADD CONSTRAINT "ChemicalImportBatch_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ChemicalImportBatch" ADD CONSTRAINT "ChemicalImportBatch_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MaterialChemistry" ADD COLUMN "importBatchId" TEXT;
ALTER TABLE "MaterialChemistry" ADD CONSTRAINT "MaterialChemistry_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ChemicalImportBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
