-- Expand only: preserve all existing labels, samples, results and associations.
ALTER TABLE "Experiment" ADD COLUMN "simCodePrefix" TEXT;
CREATE TABLE "SampleCodeReservation" (
  "organizationId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "experimentId" TEXT,
  "sampleCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SampleCodeReservation_pkey" PRIMARY KEY ("organizationId", "key"),
  CONSTRAINT "SampleCodeReservation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "SampleCodeReservation_organizationId_experimentId_idx" ON "SampleCodeReservation"("organizationId", "experimentId");

-- Seed a tombstone ledger from all available historical evidence, including
-- completed/archived/trashed samples and scans whose sample has been purged.
-- No ownership guesses and no UPDATE/DELETE of existing scientific records.
WITH codes AS (
  SELECT e."organizationId", s."simCode" AS code
  FROM "Sample" s JOIN "Experiment" e ON e.id = s."experimentId"
  WHERE s."simCode" IS NOT NULL
  UNION
  SELECT e."organizationId", unnest(s."instrumentCodes")
  FROM "Sample" s JOIN "Experiment" e ON e.id = s."experimentId"
  UNION
  SELECT "organizationId", "serialKey" FROM "JvMeasurement"
), parts AS (
  SELECT "organizationId", regexp_match(upper(code), '^([0-9]+)([A-Z]+)([0-9]+)(-|$)') AS m
  FROM codes
), reserved AS (
  SELECT "organizationId", 'PREFIX:' || (m[1]::numeric)::text || m[2] AS key
  FROM parts WHERE m IS NOT NULL
  UNION
  SELECT "organizationId", 'SAMPLE:' || (m[1]::numeric)::text || m[2] || (m[3]::numeric)::text
  FROM parts WHERE m IS NOT NULL
)
INSERT INTO "SampleCodeReservation" ("organizationId", "key")
SELECT "organizationId", key FROM reserved ON CONFLICT DO NOTHING;
