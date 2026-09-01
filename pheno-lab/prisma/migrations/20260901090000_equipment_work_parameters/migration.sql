-- 设备工艺参数: the tuning knobs techs set in daily runs, separate from the
-- spec-sheet reference values in "parameters". Additive with a default.
ALTER TABLE "Equipment" ADD COLUMN "workParameters" JSONB NOT NULL DEFAULT '[]';
