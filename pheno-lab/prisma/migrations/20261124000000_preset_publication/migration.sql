-- CreateEnum
CREATE TYPE "PresetPublicationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "PersonalPreset" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "kind" "PresetKind" NOT NULL,
    "processId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "publicPresetId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PersonalPreset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PresetPublicationRequest" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "personalPresetId" TEXT,
    "submittedById" TEXT NOT NULL,
    "sourceVersion" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "kind" "PresetKind" NOT NULL,
    "processId" TEXT NOT NULL,
    "targetPresetId" TEXT,
    "baseSnapshot" JSONB,
    "status" "PresetPublicationStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedById" TEXT,
    "reason" TEXT NOT NULL DEFAULT '',
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PresetPublicationRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PersonalPreset_organizationId_ownerId_updatedAt_idx" ON "PersonalPreset"("organizationId", "ownerId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PersonalPreset_ownerId_publicPresetId_key" ON "PersonalPreset"("ownerId", "publicPresetId");

-- CreateIndex
CREATE INDEX "PresetPublicationRequest_organizationId_status_createdAt_idx" ON "PresetPublicationRequest"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PresetPublicationRequest_personalPresetId_sourceVersion_key" ON "PresetPublicationRequest"("personalPresetId", "sourceVersion");

-- AddForeignKey
ALTER TABLE "PersonalPreset" ADD CONSTRAINT "PersonalPreset_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonalPreset" ADD CONSTRAINT "PersonalPreset_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonalPreset" ADD CONSTRAINT "PersonalPreset_processId_fkey" FOREIGN KEY ("processId") REFERENCES "Process"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonalPreset" ADD CONSTRAINT "PersonalPreset_publicPresetId_fkey" FOREIGN KEY ("publicPresetId") REFERENCES "Preset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PresetPublicationRequest" ADD CONSTRAINT "PresetPublicationRequest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PresetPublicationRequest" ADD CONSTRAINT "PresetPublicationRequest_personalPresetId_fkey" FOREIGN KEY ("personalPresetId") REFERENCES "PersonalPreset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PresetPublicationRequest" ADD CONSTRAINT "PresetPublicationRequest_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PresetPublicationRequest" ADD CONSTRAINT "PresetPublicationRequest_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
