-- 5-char solar-simulator sample codes (e.g. 01A05) and the per-technician
-- experiment letter that keeps them unique across concurrent experiments.
ALTER TABLE "Sample" ADD COLUMN IF NOT EXISTS "simCode" TEXT;
ALTER TABLE "Experiment" ADD COLUMN IF NOT EXISTS "codeLetter" TEXT;
