-- Reconcile fields and tables that were previously added with `prisma db push`
-- but never captured in a committed migration. Every operation is additive and
-- safe both for a fresh database and for an existing developer database that
-- already contains some or all of these objects.

DO $$
BEGIN
  CREATE TYPE "InstrumentKind" AS ENUM ('GIANTFORCE_IV', 'LIGHTSKY_LIV');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TYPE "ExperimentStatus" ADD VALUE IF NOT EXISTS 'REVIEW' BEFORE 'COMPLETE';

ALTER TABLE "CharacterizationResult"
  ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN IF NOT EXISTS "sourceMeasurementId" TEXT;

ALTER TABLE "Experiment"
  ADD COLUMN IF NOT EXISTS "approvedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "approvedById" TEXT,
  ADD COLUMN IF NOT EXISTS "assigneeId" TEXT,
  ADD COLUMN IF NOT EXISTS "isTest" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "reviewNote" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "shortCode" TEXT,
  ADD COLUMN IF NOT EXISTS "submitNote" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "submittedAt" TIMESTAMP(3);

ALTER TABLE "Material"
  ADD COLUMN IF NOT EXISTS "casNumber" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "category" TEXT NOT NULL DEFAULT 'OTHER',
  ADD COLUMN IF NOT EXISTS "molecularWeight" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "properties" JSONB,
  ADD COLUMN IF NOT EXISTS "purity" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "smiles" TEXT NOT NULL DEFAULT '';

ALTER TABLE "Organization"
  ADD COLUMN IF NOT EXISTS "nextShortNo" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'ACTIVE';

ALTER TABLE "Process" ADD COLUMN IF NOT EXISTS "defaultLayer" TEXT NOT NULL DEFAULT '';

ALTER TABLE "ProcessStep"
  ADD COLUMN IF NOT EXISTS "layer" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "recipeId" TEXT;

ALTER TABLE "Sample" ADD COLUMN IF NOT EXISTS "instrumentCodes" TEXT[] DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "equipmentAdmin" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "facilityAdmin" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "materialAdmin" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "recipeAccess" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "IngestItem" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "title" TEXT NOT NULL,
  "sourceFile" TEXT NOT NULL DEFAULT '',
  "confidence" TEXT NOT NULL DEFAULT '',
  "payload" JSONB NOT NULL,
  "reviewNote" TEXT NOT NULL DEFAULT '',
  "publishedId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedAt" TIMESTAMP(3),
  "reviewedById" TEXT,
  CONSTRAINT "IngestItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "OrgInvite" (
  "id" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  CONSTRAINT "OrgInvite_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "MaterialCategoryDef" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "nameZh" TEXT NOT NULL DEFAULT '',
  "position" INTEGER NOT NULL DEFAULT 0,
  "builtIn" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MaterialCategoryDef_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "DeviceLayer" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "nameZh" TEXT NOT NULL DEFAULT '',
  "position" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DeviceLayer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Recipe" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "summary" TEXT NOT NULL DEFAULT '',
  "payload" JSONB,
  "createdById" TEXT,
  "archived" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Recipe_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AiProvider" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "baseUrl" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "apiKey" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT false,
  "lastCheckedAt" TIMESTAMP(3),
  "lastStatus" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdById" TEXT,
  CONSTRAINT "AiProvider_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ExportRequest" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "requestedById" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "detail" TEXT NOT NULL DEFAULT '',
  "rowCount" INTEGER NOT NULL DEFAULT 0,
  "reason" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "decidedById" TEXT,
  "decidedAt" TIMESTAMP(3),
  "decisionNote" TEXT NOT NULL DEFAULT '',
  "downloadedAt" TIMESTAMP(3),
  "downloadCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExportRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Instrument" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "kind" "InstrumentKind" NOT NULL,
  "apiKeyHash" TEXT NOT NULL,
  "apiKeyHint" TEXT NOT NULL DEFAULT '',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "hostname" TEXT NOT NULL DEFAULT '',
  "agentVersion" TEXT NOT NULL DEFAULT '',
  "watchDirs" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "lastSeenAt" TIMESTAMP(3),
  "lastError" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Instrument_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "InstrumentUpload" (
  "id" TEXT NOT NULL,
  "instrumentId" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "sourcePath" TEXT NOT NULL DEFAULT '',
  "storedPath" TEXT NOT NULL,
  "sha256" TEXT NOT NULL,
  "size" INTEGER NOT NULL,
  "mime" TEXT NOT NULL DEFAULT '',
  "modifiedAt" TIMESTAMP(3),
  "status" TEXT NOT NULL,
  "message" TEXT NOT NULL DEFAULT '',
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InstrumentUpload_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "JvMeasurement" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "instrumentId" TEXT NOT NULL,
  "uploadId" TEXT NOT NULL,
  "serial" TEXT NOT NULL,
  "serialKey" TEXT NOT NULL,
  "scanKey" TEXT NOT NULL,
  "direction" TEXT,
  "condition" TEXT,
  "measuredAt" TIMESTAMP(3),
  "operator" TEXT NOT NULL DEFAULT '',
  "material" TEXT NOT NULL DEFAULT '',
  "metrics" JSONB NOT NULL,
  "curve" JSONB NOT NULL,
  "settings" JSONB,
  "imagePath" TEXT,
  "experimentId" TEXT,
  "sampleId" TEXT,
  "runId" TEXT,
  "status" TEXT NOT NULL,
  "matchNote" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "JvMeasurement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "OrgInvite_token_key" ON "OrgInvite"("token");
CREATE UNIQUE INDEX IF NOT EXISTS "MaterialCategoryDef_organizationId_code_key" ON "MaterialCategoryDef"("organizationId", "code");
CREATE UNIQUE INDEX IF NOT EXISTS "DeviceLayer_organizationId_code_key" ON "DeviceLayer"("organizationId", "code");
CREATE INDEX IF NOT EXISTS "AiProvider_organizationId_active_idx" ON "AiProvider"("organizationId", "active");
CREATE INDEX IF NOT EXISTS "ExportRequest_organizationId_status_idx" ON "ExportRequest"("organizationId", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "Instrument_apiKeyHash_key" ON "Instrument"("apiKeyHash");
CREATE UNIQUE INDEX IF NOT EXISTS "Instrument_organizationId_name_key" ON "Instrument"("organizationId", "name");
CREATE INDEX IF NOT EXISTS "InstrumentUpload_instrumentId_receivedAt_idx" ON "InstrumentUpload"("instrumentId", "receivedAt");
CREATE UNIQUE INDEX IF NOT EXISTS "InstrumentUpload_instrumentId_sha256_key" ON "InstrumentUpload"("instrumentId", "sha256");
CREATE INDEX IF NOT EXISTS "JvMeasurement_organizationId_status_idx" ON "JvMeasurement"("organizationId", "status");
CREATE INDEX IF NOT EXISTS "JvMeasurement_sampleId_idx" ON "JvMeasurement"("sampleId");
CREATE INDEX IF NOT EXISTS "JvMeasurement_serialKey_idx" ON "JvMeasurement"("serialKey");
CREATE UNIQUE INDEX IF NOT EXISTS "JvMeasurement_instrumentId_scanKey_key" ON "JvMeasurement"("instrumentId", "scanKey");
CREATE UNIQUE INDEX IF NOT EXISTS "Experiment_organizationId_shortCode_key" ON "Experiment"("organizationId", "shortCode");
CREATE INDEX IF NOT EXISTS "Sample_instrumentCodes_idx" ON "Sample"("instrumentCodes");

DO $$
BEGIN
  ALTER TABLE "IngestItem" ADD CONSTRAINT "IngestItem_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE "IngestItem" ADD CONSTRAINT "IngestItem_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE "Experiment" ADD CONSTRAINT "Experiment_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE "Experiment" ADD CONSTRAINT "Experiment_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE "ProcessStep" ADD CONSTRAINT "ProcessStep_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE "MaterialCategoryDef" ADD CONSTRAINT "MaterialCategoryDef_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE "DeviceLayer" ADD CONSTRAINT "DeviceLayer_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE "Recipe" ADD CONSTRAINT "Recipe_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE "Recipe" ADD CONSTRAINT "Recipe_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE "AiProvider" ADD CONSTRAINT "AiProvider_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE "ExportRequest" ADD CONSTRAINT "ExportRequest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE "ExportRequest" ADD CONSTRAINT "ExportRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE "ExportRequest" ADD CONSTRAINT "ExportRequest_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE "Instrument" ADD CONSTRAINT "Instrument_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE "InstrumentUpload" ADD CONSTRAINT "InstrumentUpload_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE "JvMeasurement" ADD CONSTRAINT "JvMeasurement_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE "JvMeasurement" ADD CONSTRAINT "JvMeasurement_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE "JvMeasurement" ADD CONSTRAINT "JvMeasurement_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "InstrumentUpload"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE "JvMeasurement" ADD CONSTRAINT "JvMeasurement_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "Experiment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE "JvMeasurement" ADD CONSTRAINT "JvMeasurement_sampleId_fkey" FOREIGN KEY ("sampleId") REFERENCES "Sample"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE "JvMeasurement" ADD CONSTRAINT "JvMeasurement_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
