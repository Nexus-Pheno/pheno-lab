-- Per-result choice of which scan statistics to display (BEST/MIN/AVERAGE/MEDIAN).
ALTER TABLE "CharacterizationResult" ADD COLUMN IF NOT EXISTS "metricPolicy" TEXT NOT NULL DEFAULT 'BEST';
