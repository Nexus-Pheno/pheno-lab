-- 课题组: manager-curated project list; experiments link to one.
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Project_organizationId_name_key" ON "Project"("organizationId", "name");

ALTER TABLE "Project" ADD CONSTRAINT "Project_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Experiment" ADD COLUMN "projectId" TEXT;
ALTER TABLE "Experiment" ADD CONSTRAINT "Experiment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Experiment_projectId_idx" ON "Experiment"("projectId");

-- Auto-seed 课题组 from the free-text campaign values already in use, so the
-- lab starts with its real research directions instead of an empty picker
-- (Michael, 2026-09-09).
--
-- Only values that behave like a group are promoted: used by at least two
-- experiments and short enough to be a name. The campaign field in practice
-- holds a mix of real group names ("control组", "Cell-4") and one-off condition
-- notes ("旋涂浓度为0.5mg/ml in 甲醇的Cell 17"); promoting every distinct value
-- would bury the picker under hundreds of single-use sentences. Everything
-- not promoted keeps its campaign text unchanged — nothing is lost, and a
-- manager can create or rename groups in the library.
-- Idempotent: the unique name absorbs re-runs, and only unfiled rows are linked.
INSERT INTO "Project" ("id", "organizationId", "name", "active", "createdAt")
SELECT
    'prj' || replace(gen_random_uuid()::text, '-', ''),
    e."organizationId",
    btrim(e."campaign"),
    true,
    CURRENT_TIMESTAMP
FROM "Experiment" e
WHERE btrim(e."campaign") <> ''
  AND char_length(btrim(e."campaign")) <= 40
GROUP BY e."organizationId", btrim(e."campaign")
HAVING count(*) >= 2
ON CONFLICT ("organizationId", "name") DO NOTHING;

UPDATE "Experiment" e
SET "projectId" = p."id"
FROM "Project" p
WHERE e."projectId" IS NULL
  AND p."organizationId" = e."organizationId"
  AND p."name" = btrim(e."campaign")
  AND btrim(e."campaign") <> '';
