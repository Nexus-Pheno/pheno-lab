-- Colloquial equipment name colleagues recognize.
ALTER TABLE "Equipment" ADD COLUMN IF NOT EXISTS "nickname" TEXT NOT NULL DEFAULT '';
