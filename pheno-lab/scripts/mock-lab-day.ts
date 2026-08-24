/**
 * Mock lab day: rebuilds a REAL measurement session from the archive as if it
 * had just come off the 小太阳, and lets the whole pipeline match it.
 *
 * Source: pheno-data/…/Chloe/20260408(1) — 4 conditions × 5-6 substrates × 2
 * pixels, measured 2026-04-08. The experiment is created FIRST, with each
 * sample declaring the serial Chloe actually typed on the instrument, so no
 * file has to be renamed for matching to work.
 *
 *   pnpm exec tsx scripts/mock-lab-day.ts          create + report
 *   pnpm exec tsx scripts/mock-lab-day.ts --clean  remove it again
 */
import { readdirSync, readFileSync } from "fs";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { generateApiKey, hashApiKey } from "../src/lib/instruments/credentials";
import { syncSampleSerials } from "../src/modules/instruments/sample-serial-engine";

const prisma = new PrismaClient();
const BASE = process.env.PHENO_URL ?? "http://127.0.0.1:3467";
const SOURCE = path.resolve(
  process.cwd(),
  "../pheno-data/AI数据– Update/AI数据20260819/Chloe/20260408(1)",
);
const TITLE = "[mock] Chloe 2026-04-08 — SAM comparison";
const RIG = "小太阳 (GiantForce)";

// The four conditions Chloe ran that day, as they appear in the serials.
const GROUPS = [
  { group: "A", prefix: "cell17", substrates: 5, label: "cell17" },
  { group: "B", prefix: "Pcell17", substrates: 5, label: "Pcell17" },
  { group: "C", prefix: "cell17p", substrates: 5, label: "cell17p" },
  { group: "D", prefix: "cell171", substrates: 6, label: "cell171" },
];

const norm = (s: string) => s.trim().toUpperCase().replace(/[\s_.]+/g, "-");

async function clean() {
  const del = await prisma.experiment.deleteMany({ where: { title: TITLE } });
  const rigs = await prisma.instrument.deleteMany({ where: { name: RIG, hostname: "MOCK-CHLOE-PC" } });
  console.log(`removed ${del.count} experiment(s), ${rigs.count} mock rig(s)`);
}

async function main() {
  if (process.argv.includes("--clean")) return clean();

  const org = await prisma.organization.findFirstOrThrow({ where: { orgNumber: 1 }, select: { id: true } });
  const user = await prisma.user.findFirstOrThrow({
    where: { organizationId: org.id, role: "ADMIN" },
    select: { id: true, name: true, userNumber: true, nextExpSeq: true },
  });
  const jvProcess = await prisma.process.findFirstOrThrow({
    where: { organizationId: org.id, kind: "CHARACTERIZATION", name: { contains: "J-V" } },
    select: { id: true },
  });
  const spin = await prisma.process.findFirst({
    where: { organizationId: org.id, kind: "PROCESSING", name: { contains: "Spin" } },
    select: { id: true },
  });

  await clean();

  // ── 1. the experiment, written up BEFORE the data is pulled ──────────────
  const code = `2026-001-${user.userNumber}-${user.nextExpSeq}`;
  const samples = GROUPS.flatMap((g) =>
    Array.from({ length: g.substrates }, (_, i) => ({
      variationGroup: g.group,
      instrumentCodes: [norm(`${g.prefix}-${i + 1}`)],
      note: `${g.label} substrate ${i + 1}`,
    })),
  ).map((s, i) => ({ ...s, code: `S${i + 1}` }));

  const experiment = await prisma.experiment.create({
    data: {
      organizationId: org.id,
      code,
      title: TITLE,
      campaign: "SAM comparison",
      status: "IN_LAB",
      createdById: user.id,
      observation: "Four hole-transport variants processed side by side on the same day.",
      hypothesis: "The p-SAM variant (Pcell17) gives the highest PCE at 0.04 cm².",
      samples: { create: samples },
      characterizations: {
        create: [{ position: 0, processId: jvProcess.id, name: "J-V — solar simulation", sampleScope: "all" }],
      },
      ...(spin ? { steps: { create: [{ position: 0, processId: spin.id, name: "Perovskite spin coating" }] } } : {}),
      runs: { create: [{ runNo: 1, status: "IN_PROGRESS", technicianId: user.id }] },
    },
    include: { samples: true },
  });
  await prisma.user.update({ where: { id: user.id }, data: { nextExpSeq: { increment: 1 } } });
  // Give it the app-assigned short serial too: samples end up answering to BOTH
  // "E11-S1" (what new work will use) and "CELL17-1" (Chloe's own naming).
  await syncSampleSerials(prisma, experiment.id);
  const seeded = await prisma.sample.findMany({
    where: { experimentId: experiment.id },
    select: { code: true, instrumentCodes: true },
    orderBy: { code: "asc" },
  });
  console.log(`\nCreated ${code} — "${TITLE}"`);
  console.log(`  ${experiment.samples.length} samples in ${GROUPS.length} variation groups`);
  console.log(`  each answers to both serials, e.g. ${seeded[0].code} → ${seeded[0].instrumentCodes.join("  +  ")}`);

  // ── 2. the rig, as if pheno-bridge had just been installed on Chloe's PC ──
  const key = generateApiKey();
  await prisma.instrument.upsert({
    where: { organizationId_name: { organizationId: org.id, name: RIG } },
    update: { apiKeyHash: hashApiKey(key), apiKeyHint: key.slice(-4), hostname: "MOCK-CHLOE-PC", active: true },
    create: {
      organizationId: org.id,
      name: RIG,
      kind: "GIANTFORCE_IV",
      apiKeyHash: hashApiKey(key),
      apiKeyHint: key.slice(-4),
      hostname: "MOCK-CHLOE-PC",
      agentVersion: "0.1.0",
      watchDirs: ["D:\\IV Measurement System\\Data"],
    },
  });

  // ── 3. push the real files exactly as the agent would ────────────────────
  const files = readdirSync(SOURCE).filter((f) => /\.(csv|jpg)$/i.test(f)).sort();
  console.log(`\nPushing ${files.length} real files from ${path.basename(SOURCE)} …`);

  const tally: Record<string, number> = {};
  let scans = 0;
  for (const name of files) {
    const buf = readFileSync(path.join(SOURCE, name));
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(buf)]), name);
    form.set("fileName", name);
    form.set("sourcePath", `D:\\IV Measurement System\\Data\\20260408\\${name}`);
    form.set("sourceDir", "D:\\IV Measurement System\\Data\\20260408");
    form.set("modifiedAt", new Date("2026-04-08T04:00:00Z").toISOString());
    form.set("hostname", "MOCK-CHLOE-PC");
    form.set("agentVersion", "0.1.0");
    const res = await fetch(`${BASE}/api/ingest/jv`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
    const body = (await res.json()) as { status: string; scans?: number; message?: string };
    tally[body.status] = (tally[body.status] ?? 0) + 1;
    scans += body.scans ?? 0;
  }
  console.log(`  ${Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(", ")} · ${scans} scans parsed`);

  // ── 4. what the app now knows ────────────────────────────────────────────
  const measurements = await prisma.jvMeasurement.findMany({
    where: { organizationId: org.id },
    select: { status: true, sampleId: true, serial: true, matchNote: true, metrics: true },
  });
  const matched = measurements.filter((m) => m.status === "MATCHED");
  const orphans = measurements.filter((m) => m.status !== "MATCHED");
  console.log(`\nMatching: ${matched.length} matched, ${orphans.length} unmatched`);
  for (const o of [...new Set(orphans.map((m) => `${m.serial} — ${m.matchNote}`))].slice(0, 6)) {
    console.log(`  · ${o}`);
  }

  const results = await prisma.characterizationResult.findMany({
    where: { sample: { experimentId: experiment.id } },
    include: { sample: { select: { code: true, variationGroup: true, instrumentCodes: true } } },
  });
  const rows = results
    .map((r) => ({
      sample: r.sample!,
      pce: Number((r.metrics as Record<string, string>)["PCE (%)"]),
      note: r.note,
    }))
    .sort((a, b) => b.pce - a.pce);

  console.log(`\nSample results auto-filled: ${rows.length}/${experiment.samples.length}`);
  console.log("  sample  group  serial        PCE");
  for (const r of rows) {
    console.log(
      `  ${r.sample.code.padEnd(7)} ${(r.sample.variationGroup ?? "-").padEnd(6)} ${r.sample.instrumentCodes.join("/").padEnd(20)} ${r.pce.toFixed(2)}%`,
    );
  }

  const byGroup = new Map<string, number[]>();
  for (const r of rows) {
    const g = r.sample.variationGroup ?? "-";
    byGroup.set(g, [...(byGroup.get(g) ?? []), r.pce]);
  }
  console.log("\nGroup means (what the results page will compare):");
  for (const g of GROUPS) {
    const list = byGroup.get(g.group) ?? [];
    if (!list.length) continue;
    const mean = list.reduce((a, b) => a + b, 0) / list.length;
    console.log(`  ${g.group} ${g.label.padEnd(9)} n=${list.length}  mean ${mean.toFixed(2)}%  best ${Math.max(...list).toFixed(2)}%`);
  }

  console.log(`\nOpen it:  ${BASE.replace("127.0.0.1", "localhost")}/experiments/${experiment.id}`);
  console.log(`Clean up: pnpm exec tsx scripts/mock-lab-day.ts --clean\n`);
}

main()
  .catch((e) => {
    console.error("\nERROR:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
