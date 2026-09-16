-- Retrieval terms on each analysis run, so a reader can see why those experiments.
ALTER TABLE "AnalysisRun" ADD COLUMN "terms" TEXT[] DEFAULT ARRAY[]::TEXT[];
