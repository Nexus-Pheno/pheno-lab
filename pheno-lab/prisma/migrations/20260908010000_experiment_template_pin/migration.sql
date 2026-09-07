-- Pin an experiment as an org-wide template (start-from-template gallery).
ALTER TABLE "Experiment" ADD COLUMN     "templatePinnedAt" TIMESTAMP(3);
