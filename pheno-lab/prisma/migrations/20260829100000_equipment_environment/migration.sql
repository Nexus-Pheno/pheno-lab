-- Environments double as locations: equipment now points at the environment
-- (room/enclosure) it lives in. locationId stays until the contract phase.
ALTER TABLE "Equipment" ADD COLUMN IF NOT EXISTS "environmentId" TEXT;
ALTER TABLE "Equipment" ADD CONSTRAINT "Equipment_environmentId_fkey"
  FOREIGN KEY ("environmentId") REFERENCES "LabEnvironment"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
