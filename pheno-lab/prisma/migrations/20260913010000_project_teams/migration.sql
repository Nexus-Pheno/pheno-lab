-- 项目组 (0909批次改善使用反馈, 2026-09-13): projects are the organization's
-- teams, and each person belongs to one so their experiments are filed there
-- by default.
ALTER TABLE "User" ADD COLUMN "projectId" TEXT;
ALTER TABLE "User" ADD CONSTRAINT "User_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "User_projectId_idx" ON "User"("projectId");

-- The 2026-09-09 auto-seed promoted campaign notes ("CBZ", "Cell-4",
-- "control组") into projects. The team confirmed those are condition notes,
-- not teams (0909批次改善使用反馈 §一), and Michael approved removing them and
-- their links. Only the seeded rows are touched — they carry the 'prj' id
-- prefix the seed used, while human-created rows are cuids — and every
-- experiment keeps its campaign text exactly as it was.
UPDATE "Experiment" SET "projectId" = NULL
WHERE "projectId" IN (SELECT "id" FROM "Project" WHERE "id" LIKE 'prj%');
DELETE FROM "Project" WHERE "id" LIKE 'prj%';
