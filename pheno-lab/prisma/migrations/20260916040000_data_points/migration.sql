-- Running total of measurement data points per organization.
ALTER TABLE "Organization" ADD COLUMN "dataPoints" INTEGER NOT NULL DEFAULT 0;
