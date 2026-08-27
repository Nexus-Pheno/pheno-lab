-- Material-valued capture actuals retain a foreign-key link to their
-- canonical Material card while StepExecution.actuals keeps the display text.
CREATE TABLE "ExecutionMaterial" (
    "id" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "parameterName" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,

    CONSTRAINT "ExecutionMaterial_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExecutionMaterial_executionId_parameterName_key"
ON "ExecutionMaterial"("executionId", "parameterName");

CREATE INDEX "ExecutionMaterial_materialId_idx"
ON "ExecutionMaterial"("materialId");

ALTER TABLE "ExecutionMaterial"
ADD CONSTRAINT "ExecutionMaterial_executionId_fkey"
FOREIGN KEY ("executionId") REFERENCES "StepExecution"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ExecutionMaterial"
ADD CONSTRAINT "ExecutionMaterial_materialId_fkey"
FOREIGN KEY ("materialId") REFERENCES "Material"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
