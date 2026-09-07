-- Experiment discussion threads (batch 3 F4). Mentions notify only; they
-- grant no access.
CREATE TABLE "ExperimentComment" (
    "id" TEXT NOT NULL,
    "experimentId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExperimentComment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ExperimentComment_experimentId_createdAt_idx" ON "ExperimentComment"("experimentId", "createdAt");

ALTER TABLE "ExperimentComment" ADD CONSTRAINT "ExperimentComment_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "Experiment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ExperimentComment" ADD CONSTRAINT "ExperimentComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
