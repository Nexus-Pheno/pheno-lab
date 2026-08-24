/**
 * Verifies the instrument parsers against the real files captured from the two
 * lab PCs on 2026-08-20.  Run: pnpm exec tsx scripts/check-instrument-parsers.ts
 */
import { readFileSync } from "fs";
import path from "path";
import { parseInstrumentFile, UnsupportedInstrumentFile } from "../src/lib/instruments";
import type { JvScan } from "../src/lib/instruments";

const DIR = path.join(process.cwd(), "src/lib/instruments/__fixtures__");
let failures = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : `  expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}

function near(label: string, actual: number | undefined, expected: number, tol = 1e-6) {
  const ok = actual !== undefined && Math.abs(actual - expected) <= tol;
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? ` = ${actual}` : `  expected ~${expected}, got ${actual}`}`);
}

function iso(d: Date | null) {
  return d ? d.toISOString() : null;
}

/** Independent sanity check: FF = Pmax / (Voc·Isc), PCE = Pmax / (area·100 mW/cm²). */
function crossCheck(s: JvScan, ffTol = 0.05, pceTol = 0.05) {
  const { voc, isc, pmax, pce, ff, area } = s.metrics;
  if (voc && isc && pmax && ff !== undefined) {
    near(`    FF recomputed from Pmax/(Voc·Isc)`, (pmax / (voc * isc)) * 100, ff, ffTol);
  }
  if (pmax && area && pce !== undefined) {
    near(`    PCE recomputed from Pmax/(area·100)`, (pmax / (area * 100)) * 100, pce, pceTol);
  }
}

console.log("\n── GiantForce (小太阳) · auto-saved single pixel ──");
{
  const buf = readFileSync(path.join(DIR, "giantforce-auto-single.csv"));
  const r = parseInstrumentFile(buf, { fileName: "C1-1_Cindy_perovskite_Light_Normal_Rev_1_143040.csv" });
  check("instrument", r.instrument, "GIANTFORCE_IV");
  check("scan count", r.scans.length, 1);
  const s = r.scans[0];
  check("serial", s.serial, "C1-1");
  check("operator", s.operator, "Cindy");
  check("material", s.material, "perovskite");
  check("direction", s.direction, "REVERSE");
  check("condition", s.condition, "LIGHT");
  check("measuredAt (14:30:40 +08)", iso(s.measuredAt), "2026-08-20T06:30:40.000Z");
  near("Voc", s.metrics.voc, 1.158118);
  near("Isc", s.metrics.isc, 1.007358);
  near("Jsc", s.metrics.jsc, 25.183943);
  near("PCE", s.metrics.pce, 25.804105);
  near("FF", s.metrics.ff, 88.47329);
  near("Rsh", s.metrics.rsh, 3082029.395372);
  near("area", s.metrics.area, 0.04);
  check("curve points (Point Num. = 101)", s.curve.length, 101);
  check("first point", s.curve[0], { v: -0.1, i: 1.00754, p: -0.100754, j: 25.1885 });
  near("last V = Stop Voltage", s.curve[s.curve.length - 1].v, 1.25);
  check("settings", s.settings, { startVoltage: -0.1, stopVoltage: 1.25, scanSpeed: "Auto", testMode: "Normal", points: 101 });
  crossCheck(s);
  check("warnings", r.warnings, []);
}

console.log("\n── GiantForce (小太阳) · manual 'Save Data' (4 pixels side by side) ──");
{
  const buf = readFileSync(path.join(DIR, "giantforce-manual-data.csv"));
  const r = parseInstrumentFile(buf, { fileName: "C2-2_Cindy_Data_20260820143458.csv" });
  check("scan count", r.scans.length, 4);
  check("serials", r.scans.map((s) => s.serial), ["C1-1", "C1-2", "C2-1", "C2-2"]);
  check("all reverse", r.scans.every((s) => s.direction === "REVERSE"), true);
  check("all 101 points", r.scans.every((s) => s.curve.length === 101), true);
  check("PCEs", r.scans.map((s) => s.metrics.pce), [25.804105, 25.498632, 25.324962, 25.463331]);
  check("distinct timestamps", new Set(r.scans.map((s) => iso(s.measuredAt))).size, 4);
  r.scans.forEach((s) => crossCheck(s));
}

console.log("\n── GiantForce (小太阳) · manual 'Save table' must be rejected ──");
{
  const buf = readFileSync(path.join(DIR, "giantforce-manual-table.csv"));
  try {
    parseInstrumentFile(buf, { fileName: "C2-2_Cindy_Table_20260820143644.csv" });
    console.log("  ✗ expected a rejection, got a parse");
    failures++;
  } catch (e) {
    const ok = e instanceof UnsupportedInstrumentFile;
    if (!ok) failures++;
    console.log(`  ${ok ? "✓" : "✗"} rejected: ${(e as Error).message}`);
  }
}

console.log("\n── LIGHTSKY (大太阳) · saved session, 3 traces ──");
{
  const buf = readFileSync(path.join(DIR, "lightsky-session.csv"));
  const r = parseInstrumentFile(buf, {
    fileName: "123.xls",
    sourceDir: "D:\\Lily\\2026",
    fileModifiedAt: new Date("2026-08-20T07:40:00Z"), // 15:40 in Shenzhen
  });
  check("instrument", r.instrument, "LIGHTSKY_LIV");
  check("scan count", r.scans.length, 3);
  check("serials (direction suffix stripped)", r.scans.map((s) => s.serial), ["06-8", "05-8", "10-8"]);
  check("directions", r.scans.map((s) => s.direction), ["REVERSE", "REVERSE", "REVERSE"]);
  const s = r.scans[0];
  check("trace name kept", s.settings.traceName, "06-8-Rev");
  near("Voc", s.metrics.voc, 11.5126772709);
  near("Jsc", s.metrics.jsc, 2.2291051644);
  near("PCE", s.metrics.pce, 18.2093523267);
  near("FF", s.metrics.ff, 70.9557525495);
  near("area", s.metrics.area, 63.18);
  check("curve points (−0.1 V → 11.7 V at 0.1 V)", s.curve.length, 119);
  check("sign was flipped to photocurrent-positive", s.settings.signFlipped, true);
  near("I at first point is now positive", s.curve[0].i, 140.9973999999999);
  near("measuredAt takes 15:29:40 from the summary, date from the folder", s.measuredAt!.getTime(), Date.parse("2026-08-20T07:29:40Z"));
  check("no warnings", r.warnings, []);
  r.scans.forEach((sc) => crossCheck(sc, 0.5, 0.5));
}

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 1 & 0 : 1);
