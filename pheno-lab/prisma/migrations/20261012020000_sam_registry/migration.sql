-- Separate the new SAM portal from the existing scientific material catalogue.
-- Existing materials, SMILES and generated evidence remain untouched.
ALTER TABLE "MaterialChemistry" ADD COLUMN "inSamRegistry" BOOLEAN NOT NULL DEFAULT false;
