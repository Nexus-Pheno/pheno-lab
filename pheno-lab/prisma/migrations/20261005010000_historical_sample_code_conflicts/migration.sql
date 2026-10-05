-- Add a safety marker in the new ledger only; no relabeling or result repair.
ALTER TABLE "SampleCodeReservation" ADD COLUMN "ambiguous" BOOLEAN NOT NULL DEFAULT false;
WITH claims AS (
  SELECT e."organizationId", s."simCode" AS code, e.id || ':' || upper(s.code) AS owner
  FROM "Sample" s JOIN "Experiment" e ON e.id = s."experimentId"
  WHERE s."simCode" IS NOT NULL
  UNION
  SELECT e."organizationId", unnest(s."instrumentCodes"), e.id || ':' || upper(s.code)
  FROM "Sample" s JOIN "Experiment" e ON e.id = s."experimentId"
  UNION
  SELECT m."organizationId", m."serialKey", s."experimentId" || ':' || upper(s.code)
  FROM "JvMeasurement" m JOIN "Sample" s ON s.id = m."sampleId"
), parts AS (
  SELECT "organizationId", owner, regexp_match(upper(code), '^([0-9]+)([A-Z]+)([0-9]+)(-|$)') AS m
  FROM claims
), canonical AS (
  SELECT "organizationId", owner,
    'SAMPLE:' || (m[1]::numeric)::text || m[2] || (m[3]::numeric)::text AS key
  FROM parts WHERE m IS NOT NULL
)
INSERT INTO "SampleCodeReservation" ("organizationId", "key", "ambiguous")
SELECT "organizationId", key, count(DISTINCT owner) > 1 FROM canonical GROUP BY "organizationId", key
ON CONFLICT ("organizationId", "key") DO UPDATE
SET "ambiguous" = "SampleCodeReservation"."ambiguous" OR EXCLUDED."ambiguous";
