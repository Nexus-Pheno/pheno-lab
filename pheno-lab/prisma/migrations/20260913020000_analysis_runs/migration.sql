-- Free-form cross-experiment analysis runs (0909批次改善使用反馈 §二).
CREATE TABLE "AnalysisRun" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "lang" TEXT NOT NULL DEFAULT 'zh',
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "text" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL DEFAULT '',
    "experiments" INTEGER NOT NULL DEFAULT 0,
    "samples" INTEGER NOT NULL DEFAULT 0,
    "experimentCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "AnalysisRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AnalysisRun_organizationId_startedAt_idx" ON "AnalysisRun"("organizationId", "startedAt");

ALTER TABLE "AnalysisRun" ADD CONSTRAINT "AnalysisRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AnalysisRun" ADD CONSTRAINT "AnalysisRun_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
