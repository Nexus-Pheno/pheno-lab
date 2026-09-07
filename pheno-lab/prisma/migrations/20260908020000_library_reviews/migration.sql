CREATE TYPE "LibraryReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
ALTER TABLE "User" ADD COLUMN "recipeSteward" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Recipe" ADD COLUMN "approvalStatus" "LibraryReviewStatus" NOT NULL DEFAULT 'APPROVED';
CREATE TABLE "MaterialEditSuggestion" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "materialId" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "reviewedById" TEXT,
  "status" "LibraryReviewStatus" NOT NULL DEFAULT 'PENDING',
  "baseSnapshot" JSONB NOT NULL,
  "changes" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedAt" TIMESTAMP(3),
  CONSTRAINT "MaterialEditSuggestion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MaterialEditSuggestion_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "MaterialEditSuggestion_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MaterialEditSuggestion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "MaterialEditSuggestion_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "MaterialEditSuggestion_organizationId_status_createdAt_idx" ON "MaterialEditSuggestion"("organizationId", "status", "createdAt");
