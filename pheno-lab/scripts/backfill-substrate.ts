/**
 * Apply the substrate fields recovered by backfill-substrate.py.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/backfill-substrate.ts FILE          # dry run
 *   node node_modules/tsx/dist/cli.mjs scripts/backfill-substrate.ts FILE --apply
 *
 * Each record is matched to the published experiment by the import's own
 * metadata (imported, sourceFiles[0], batchLabel, sourceDate) and its fields
 * become parameters on the experiment's substrate-cleaning step (the first
 * step when there is none), so they read as recipe conditions everywhere —
 * data table, report, cross-experiment analysis. Idempotent: a parameter
 * that already exists by name is left alone. One SYSTEM audit event per
 * experiment touched.
 */
import { readFileSync } from "node:fs";
import { db } from "../src/infrastructure/db/client";
import { recordSystemAudit } from "../src/modules/audit/writer";

type Record_ = {
  sourceFile: string;
  batchLabel: string;
  sourceDate: string;
  fields: Record<string, string>;
};

const ORDER = ["基底尺寸", "模组尺寸", "基底", "器件结构", "补充材料"];

async function main() {
  const [file, flag] = process.argv.slice(2);
  if (!file) throw new Error("usage: backfill-substrate.ts FILE [--apply]");
  const apply = flag === "--apply";
  const records = JSON.parse(readFileSync(file, "utf8")) as Record_[];

  const experiments = await db.experiment.findMany({
    where: { metadata: { path: ["imported"], equals: true } },
    select: {
      id: true,
      code: true,
      organizationId: true,
      metadata: true,
      steps: {
        orderBy: { position: "asc" },
        select: {
          id: true,
          process: { select: { name: true } },
          parameters: { select: { name: true, position: true } },
        },
      },
    },
  });
  const byKey = new Map<string, (typeof experiments)[number]>();
  for (const exp of experiments) {
    const m = (exp.metadata ?? {}) as {
      sourceFiles?: string[];
      batchLabel?: string;
      sourceDate?: string;
    };
    byKey.set(
      `${m.sourceFiles?.[0] ?? ""}|${m.batchLabel ?? ""}|${m.sourceDate ?? ""}`,
      exp,
    );
  }

  let matched = 0,
    unmatched = 0,
    touched = 0,
    added = 0,
    skippedNoStep = 0;
  for (const record of records) {
    const exp = byKey.get(
      `${record.sourceFile}|${record.batchLabel}|${record.sourceDate}`,
    );
    if (!exp) {
      unmatched += 1;
      continue;
    }
    matched += 1;
    const step =
      exp.steps.find((s) => s.process.name === "Cleaning / washing") ??
      exp.steps[0];
    if (!step) {
      skippedNoStep += 1;
      continue;
    }
    const have = new Set(step.parameters.map((p) => p.name));
    const toAdd = ORDER.filter(
      (name) => record.fields[name] && !have.has(name),
    );
    if (toAdd.length === 0) continue;
    touched += 1;
    added += toAdd.length;
    if (!apply) continue;
    let position =
      step.parameters.reduce((m, p) => Math.max(m, p.position), -1) + 1;
    await db.$transaction(async (tx) => {
      for (const name of toAdd) {
        await tx.stepParameter.create({
          data: {
            stepId: step.id,
            position: position++,
            name,
            unit: name === "基底尺寸" ? "mm" : "",
            value:
              name === "基底尺寸"
                ? record.fields[name].replace(/\s*mm$/, "")
                : record.fields[name],
            source: "custom",
          },
        });
      }
      await recordSystemAudit(tx, {
        organizationId: exp.organizationId,
        action: "experiment.backfill.substrate",
        entityType: "Experiment",
        entityId: exp.id,
        changes: Object.fromEntries(toAdd.map((n) => [n, record.fields[n]])),
        metadata: { source: record.sourceFile, batchLabel: record.batchLabel },
      });
    });
  }
  console.log(
    `${apply ? "APPLIED" : "DRY RUN"}: records ${records.length}, matched ${matched}, unmatched ${unmatched}, ` +
      `experiments to touch ${touched}, parameters to add ${added}, no-step ${skippedNoStep}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
