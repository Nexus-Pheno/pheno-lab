/**
 * End-to-end check of the instrument ingest path: registers a throwaway rig,
 * builds a temporary experiment, POSTs the real fixture files through the HTTP
 * endpoint, verifies what landed, then deletes everything it created.
 *
 *   pnpm exec tsx scripts/check-ingest-e2e.ts [baseUrl]
 */
import { readFileSync } from "fs";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { generateApiKey, hashApiKey } from "../src/lib/instruments/auth";
import { rematchMeasurements } from "../src/lib/instruments/rematch";
import { syncSampleSerials } from "../src/lib/instruments/assign";

const prisma = new PrismaClient();
const BASE = process.argv[2] ?? "http://127.0.0.1:3467";
const FIXTURES = path.join(process.cwd(), "src/lib/instruments/__fixtures__");
const CODE = "2026-001-9-99"; // throwaway experiment code

let failures = 0;
function ok(label: string, cond: boolean, detail = "") {
  if (!cond) failures++;
  console.log(`  ${cond ? "✓" : "✗"} ${label}${cond || !detail ? "" : `  → ${detail}`}`);
}

async function post(file: Buffer, fileName: string, key: string, extra: Record<string, string> = {}) {
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(file)]), fileName);
  form.set("fileName", fileName);
  form.set("sourcePath", `D:\\IV Measurement System\\Data\\20260820\\${fileName}`);
  form.set("sourceDir", "D:\\IV Measurement System\\Data\\20260820");
  form.set("modifiedAt", new Date().toISOString());
  for (const [k, v] of Object.entries(extra)) form.set(k, v);
  const res = await fetch(`${BASE}/api/ingest/jv`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  return { code: res.status, body: (await res.json()) as { status: string; scans: number; message: string } };
}

async function main() {
  const org = await prisma.organization.findFirstOrThrow({ where: { orgNumber: 1 }, select: { id: true } });
  const user = await prisma.user.findFirstOrThrow({ where: { organizationId: org.id }, select: { id: true } });
  const process_ = await prisma.process.findFirstOrThrow({
    where: { organizationId: org.id, kind: "CHARACTERIZATION", name: { contains: "J-V" } },
    select: { id: true },
  });

  // ── fixture: a throwaway experiment with two samples and a J-V card ───────
  await prisma.experiment.deleteMany({ where: { code: CODE } });
  const exp = await prisma.experiment.create({
    data: {
      organizationId: org.id,
      code: CODE,
      title: "[ingest e2e] temporary",
      createdById: user.id,
      status: "IN_LAB",
      samples: { create: [{ code: "S1" }, { code: "S2" }] },
      characterizations: { create: [{ position: 0, processId: process_.id, name: "J-V — solar simulation" }] },
      runs: { create: [{ runNo: 1 }] },
    },
    include: { samples: true, runs: true },
  });
  const s1 = exp.samples.find((s) => s.code === "S1")!;

  const key = generateApiKey();
  const rig = await prisma.instrument.create({
    data: {
      organizationId: org.id,
      name: "[e2e] 小太阳",
      kind: "GIANTFORCE_IV",
      apiKeyHash: hashApiKey(key),
      apiKeyHint: key.slice(-4),
    },
  });

  try {
    console.log(`\n── auth ──`);
    const bad = await fetch(`${BASE}/api/ingest/heartbeat`, { headers: { Authorization: "Bearer nope" } });
    ok("a wrong key is rejected with 401", bad.status === 401, String(bad.status));
    const good = await fetch(`${BASE}/api/ingest/heartbeat`, { headers: { Authorization: `Bearer ${key}` } });
    ok("the real key passes the test endpoint", good.status === 200, String(good.status));

    console.log(`\n── GiantForce: two pixels of ${CODE}-S1 ──`);
    // What the lab will actually produce once operators type our sample IDs.
    const raw = readFileSync(path.join(FIXTURES, "giantforce-auto-single.csv")).toString("utf8");
    const pixel1 = Buffer.from(raw.replace("Serial NO.:,C1-1", `Serial NO.:,${CODE}-S1-1`), "utf8");
    // Second pixel: same sample, deliberately WORSE (PCE 25.80 → 21.50).
    const pixel2 = Buffer.from(
      raw.replace("Serial NO.:,C1-1", `Serial NO.:,${CODE}-S1-2`).replace("Efficiency(%):, 25.804105", "Efficiency(%):, 21.500000"),
      "utf8",
    );

    const r1 = await post(pixel1, `${CODE}-S1-1_Cindy_perovskite_Light_Normal_Rev_1_143040.csv`, key);
    ok("pixel 1 stored", r1.code === 200 && r1.body.status === "stored", JSON.stringify(r1.body));
    ok("one scan parsed", r1.body.scans === 1, String(r1.body.scans));

    const r2 = await post(pixel2, `${CODE}-S1-2_Cindy_perovskite_Light_Normal_Rev_1_143103.csv`, key);
    ok("pixel 2 stored", r2.code === 200 && r2.body.status === "stored", JSON.stringify(r2.body));

    const dup = await post(pixel1, `copy-of-pixel1.csv`, key);
    ok("re-sending identical bytes is a 409 duplicate", dup.code === 409, JSON.stringify(dup.body));

    const measurements = await prisma.jvMeasurement.findMany({ where: { instrumentId: rig.id }, orderBy: { serial: "asc" } });
    ok("two measurements recorded", measurements.length === 2, String(measurements.length));
    ok("both matched to sample S1", measurements.every((m) => m.sampleId === s1.id));
    ok("pixel suffix noted, not modelled", /Pixel 1/.test(measurements[0].matchNote), measurements[0].matchNote);
    ok("run attached", measurements.every((m) => m.runId === exp.runs[0].id));
    ok("curve stored", (measurements[0].curve as unknown[]).length === 101);

    const result = await prisma.characterizationResult.findFirst({ where: { sampleId: s1.id } });
    ok("a sample-level result was auto-filled", !!result);
    ok("it took the BEST pixel (25.80, not 21.50)", (result?.metrics as Record<string, string>)?.["PCE (%)"] === "25.80",
      JSON.stringify(result?.metrics));
    // jsonb does not preserve key order, so compare as a set.
    const labels = Object.keys((result?.metrics ?? {}) as object).sort();
    ok("metric labels match the capture portal's",
      JSON.stringify(labels) === JSON.stringify(["FF (%)", "Jsc (mA/cm²)", "PCE (%)", "Voc (V)"]),
      JSON.stringify(labels));
    ok("marked as instrument-sourced", result?.source === "INSTRUMENT");
    ok("note explains the pick", /best of 2 scans/.test(result?.note ?? ""), result?.note);

    console.log(`\n── a technician's typed value is never overwritten ──`);
    await prisma.characterizationResult.update({
      where: { id: result!.id },
      data: { source: "MANUAL", metrics: { "PCE (%)": "19.00" }, note: "typed by hand" },
    });
    const pixel3 = Buffer.from(raw.replace("Serial NO.:,C1-1", `Serial NO.:,${CODE}-S1-3`), "utf8");
    const r3 = await post(pixel3, `${CODE}-S1-3_Cindy_perovskite_Light_Normal_Rev_1_143200.csv`, key);
    ok("upload still accepted", r3.code === 200, JSON.stringify(r3.body));
    ok("server says it kept the manual value", /kept the value/.test(r3.body.message), r3.body.message);
    const after = await prisma.characterizationResult.findUnique({ where: { id: result!.id } });
    ok("manual 19.00 survived", (after?.metrics as Record<string, string>)?.["PCE (%)"] === "19.00",
      JSON.stringify(after?.metrics));

    console.log(`\n── unknown serials land in a review queue, not the bin ──`);
    const stranger = await post(readFileSync(path.join(FIXTURES, "giantforce-manual-data.csv")), "C2-2_Cindy_Data.csv", key);
    ok("accepted but reported unmatched", stranger.code === 200 && stranger.body.status === "unmatched", JSON.stringify(stranger.body));
    ok("all four scans kept", stranger.body.scans === 4, String(stranger.body.scans));
    ok("message names the problem", /is not an experiment code/.test(stranger.body.message), stranger.body.message);
    const orphans = await prisma.jvMeasurement.count({ where: { instrumentId: rig.id, status: "UNMATCHED" } });
    ok("four unmatched rows stored for review", orphans === 4, String(orphans));

    console.log(`\n── the 'Save table' export is refused with an explanation ──`);
    const table = await post(readFileSync(path.join(FIXTURES, "giantforce-manual-table.csv")), "C2-2_Cindy_Table.csv", key);
    ok("422 so the agent stops retrying", table.code === 422, String(table.code));
    ok("explains why", /Save table/.test(table.body.message), table.body.message);

    console.log(`\n── LIGHTSKY session file ──`);
    const lsKey = generateApiKey();
    const lsRig = await prisma.instrument.create({
      data: {
        organizationId: org.id,
        name: "[e2e] 大太阳",
        kind: "LIGHTSKY_LIV",
        apiKeyHash: hashApiKey(lsKey),
        apiKeyHint: lsKey.slice(-4),
      },
    });
    try {
      const ls = await post(readFileSync(path.join(FIXTURES, "lightsky-session.csv")), "123.xls", lsKey, {
        sourceDir: "D:\\Lily\\2026",
      });
      ok("three traces parsed", ls.body.scans === 3, JSON.stringify(ls.body));
      const lsRows = await prisma.jvMeasurement.findMany({ where: { instrumentId: lsRig.id } });
      ok("stored with module-scale metrics", (lsRows[0]?.metrics as { voc: number })?.voc > 11);
      ok("saved as .xls but parsed by content", lsRows.length === 3, String(lsRows.length));
    } finally {
      await prisma.instrument.delete({ where: { id: lsRig.id } });
    }

    console.log(`\n── the same scan inside a different file is not counted twice ──`);
    // The LIGHTSKY operator ticks "Select All" every session, so session 2's
    // file re-contains session 1's traces with different bytes.
    const lsKey2 = generateApiKey();
    const lsRig2 = await prisma.instrument.create({
      data: {
        organizationId: org.id,
        name: "[e2e] 大太阳 resave",
        kind: "LIGHTSKY_LIV",
        apiKeyHash: hashApiKey(lsKey2),
        apiKeyHint: lsKey2.slice(-4),
      },
    });
    try {
      const session1 = readFileSync(path.join(FIXTURES, "lightsky-session.csv"));
      const first = await post(session1, "session1.csv", lsKey2, { sourceDir: "D:\\Lily\\2026" });
      ok("first save: 3 new scans", first.body.scans === 3, JSON.stringify(first.body));

      // Same traces, different bytes (a trailing blank line, as a re-save gives).
      const session2 = Buffer.concat([session1, Buffer.from("\r\n")]);
      const second = await post(session2, "session2.csv", lsKey2, { sourceDir: "D:\\Lily\\2026" });
      ok("re-saved file is accepted, not 409", second.code === 200, String(second.code));
      ok("but adds 0 new scans", second.body.scans === 0, JSON.stringify(second.body));
      ok("and says so", /already recorded/.test(second.body.message), second.body.message);
      const total = await prisma.jvMeasurement.count({ where: { instrumentId: lsRig2.id } });
      ok("still exactly 3 measurements", total === 3, String(total));
      const files = await prisma.instrumentUpload.count({ where: { instrumentId: lsRig2.id } });
      ok("both raw files are kept for replay", files === 2, String(files));
    } finally {
      await prisma.instrument.delete({ where: { id: lsRig2.id } });
    }

    console.log(`\n── a scan that arrives before its experiment is matched later ──`);
    const LATE = "2026-001-9-98";
    await prisma.experiment.deleteMany({ where: { code: LATE } });
    const early = Buffer.from(raw.replace("Serial NO.:,C1-1", `Serial NO.:,${LATE}-S1`), "utf8");
    const earlyRes = await post(early, `${LATE}-S1_Cindy.csv`, key);
    ok("arrives unmatched", earlyRes.body.status === "unmatched", JSON.stringify(earlyRes.body));
    ok("reason recorded", /No experiment 2026-001-9-98/.test(earlyRes.body.message), earlyRes.body.message);

    // The technician writes the experiment up after lunch.
    const late = await prisma.experiment.create({
      data: {
        organizationId: org.id,
        code: LATE,
        title: "[ingest e2e] written up later",
        createdById: user.id,
        status: "IN_LAB",
        samples: { create: [{ code: "S1" }] },
        characterizations: { create: [{ position: 0, processId: process_.id, name: "J-V — solar simulation" }] },
        runs: { create: [{ runNo: 1 }] },
      },
      include: { samples: true },
    });
    const sweep = await rematchMeasurements({ organizationId: org.id, serialPrefixes: [LATE] });
    ok("the sweep matches it", sweep.matched === 1, JSON.stringify(sweep));
    const lateResult = await prisma.characterizationResult.findFirst({ where: { sampleId: late.samples[0].id } });
    ok("and the sample result is filled in", (lateResult?.metrics as Record<string, string>)?.["PCE (%)"] === "25.80",
      JSON.stringify(lateResult?.metrics));
    await prisma.experiment.deleteMany({ where: { code: LATE } });

    console.log(`\n── short serials, and surviving a test-plan edit ──`);
    const SHORT = "2026-001-9-97";
    await prisma.experiment.deleteMany({ where: { code: SHORT } });
    const shortExp = await prisma.experiment.create({
      data: {
        organizationId: org.id,
        code: SHORT,
        title: "[ingest e2e] short serial",
        createdById: user.id,
        status: "IN_LAB",
        samples: { create: [{ code: "S1" }, { code: "S2" }] },
        characterizations: { create: [{ position: 0, processId: process_.id, name: "J-V — solar simulation" }] },
        runs: { create: [{ runNo: 1 }] },
      },
    });
    await syncSampleSerials(prisma, shortExp.id);
    const before = await prisma.experiment.findUniqueOrThrow({
      where: { id: shortExp.id },
      select: { shortCode: true, samples: { select: { id: true, code: true, instrumentCodes: true } } },
    });
    const s1Before = before.samples.find((s) => s.code === "S1")!;
    const serial = s1Before.instrumentCodes[0];
    ok("the app assigned a short serial", /^E\d+-S1$/.test(serial), serial);

    const shortFile = Buffer.from(raw.replace("Serial NO.:,C1-1", `Serial NO.:,${serial}-2`), "utf8");
    const shortRes = await post(shortFile, `${serial}-2_Chloe.csv`, key);
    ok("a scan typed with the short serial matches", shortRes.body.status === "stored", JSON.stringify(shortRes.body));
    const m1 = await prisma.jvMeasurement.findFirstOrThrow({ where: { serialKey: `${serial}-2` } });
    ok("attached to S1", m1.sampleId === s1Before.id);
    ok("pixel suffix noted", /pixel 2/i.test(m1.matchNote), m1.matchNote);

    // Now edit the test plan: applyTestPlan deletes and recreates every sample.
    await prisma.sample.deleteMany({ where: { experimentId: shortExp.id } });
    await prisma.sample.createMany({
      data: [
        { experimentId: shortExp.id, code: "S1", variationGroup: "A" },
        { experimentId: shortExp.id, code: "S2", variationGroup: "A" },
        { experimentId: shortExp.id, code: "S3", variationGroup: "B" },
      ],
    });
    await syncSampleSerials(prisma, shortExp.id);

    const stranded = await prisma.jvMeasurement.findUniqueOrThrow({ where: { id: m1.id } });
    ok("deleting samples strands the measurement (sampleId is nulled)", stranded.sampleId === null);

    const healed = await rematchMeasurements({ organizationId: org.id, serialPrefixes: [before.shortCode!] });
    ok("the sweep re-attaches it", healed.matched === 1, JSON.stringify(healed));
    const after2 = await prisma.jvMeasurement.findUniqueOrThrow({
      where: { id: m1.id },
      select: { sampleId: true, status: true, sample: { select: { code: true } } },
    });
    ok("back on S1 — the same sample by serial, a new row by id", after2.sample?.code === "S1" && after2.sampleId !== s1Before.id,
      JSON.stringify(after2));
    const restored = await prisma.characterizationResult.findFirst({ where: { sampleId: after2.sampleId! } });
    ok("and the sample result is rebuilt", (restored?.metrics as Record<string, string>)?.["PCE (%)"] === "25.80",
      JSON.stringify(restored?.metrics));
    await prisma.experiment.deleteMany({ where: { code: SHORT } });

    console.log(`\n── heartbeat ──`);
    await fetch(`${BASE}/api/ingest/heartbeat`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ hostname: "DESKTOP-MGMS5H0", agentVersion: "0.1.0", watchDirs: ["D:\\IV Measurement System\\Data"] }),
    });
    const beat = await prisma.instrument.findUnique({ where: { id: rig.id } });
    ok("liveness recorded", !!beat?.lastSeenAt && beat.hostname === "DESKTOP-MGMS5H0", beat?.hostname);
  } finally {
    await prisma.instrument.deleteMany({ where: { name: { startsWith: "[e2e]" } } });
    await prisma.experiment.deleteMany({ where: { code: CODE } });
    console.log("\n(cleaned up the temporary experiment and rigs)");
  }

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((e) => {
    console.error("\nERROR:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
