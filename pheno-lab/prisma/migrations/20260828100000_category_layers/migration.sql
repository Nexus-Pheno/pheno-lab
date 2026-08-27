-- Material categories map to the device layers their materials serve.
ALTER TABLE "MaterialCategoryDef" ADD COLUMN IF NOT EXISTS "layers" TEXT[] NOT NULL DEFAULT '{}';
