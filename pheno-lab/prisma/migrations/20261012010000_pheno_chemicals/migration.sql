ALTER TABLE "User" ADD COLUMN "chemicalAccess" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "MaterialChemistry" (
  "materialId" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "canonicalSmiles" TEXT NOT NULL,
  "inputSha256" TEXT NOT NULL,
  "structurePath" TEXT NOT NULL,
  "structureSha256" TEXT NOT NULL,
  "structureBytes" INTEGER NOT NULL,
  "engineVersion" TEXT NOT NULL,
  "atomCount" INTEGER NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MaterialChemistry_pkey" PRIMARY KEY ("materialId")
);
CREATE UNIQUE INDEX "MaterialChemistry_structurePath_key" ON "MaterialChemistry"("structurePath");
CREATE UNIQUE INDEX "MaterialChemistry_requestId_key" ON "MaterialChemistry"("requestId");
ALTER TABLE "MaterialChemistry" ADD CONSTRAINT "MaterialChemistry_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE CASCADE ON UPDATE CASCADE;
