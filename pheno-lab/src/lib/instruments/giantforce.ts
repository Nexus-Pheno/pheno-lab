// GiantForce "IV Measurement System" — the 小太阳 single-cell simulator.
//
// Auto-save (what we actually ingest) writes one CSV per measured pixel into
//   D:\IV Measurement System\Data\<YYYYMMDD>\
//   <Serial>_<Operator>_<Material>_<Light|Dark>_<Mode>_<Rev|For>_<n>_<HHMMSS>.csv
// plus a same-named .jpg screenshot of the software window.
//
// The manual "Save Data" export is the same report repeated horizontally, three
// columns per scan, so one parser covers both. The manual "Save table" export
// carries no curve and is rejected (it would duplicate auto-saved rows).

import { cell, isNumeric, num } from "./csv";
import { wallClockToDate } from "./time";
import type { CurvePoint, JvScan, ParsedJvFile, ScanDirection, TestCondition } from "./types";
import { UnsupportedInstrumentFile } from "./types";

const LABELS: Record<string, string> = {
  "material:": "material",
  "serialno.:": "serial",
  "operator:": "operator",
  "samplearea(cm2):": "area",
  "testcondition:": "condition",
  "startvoltage(v):": "startVoltage",
  "stopvoltage(v):": "stopVoltage",
  "direction:": "direction",
  "scanningspeed(mv/s):": "scanSpeed",
  "testmode:": "testMode",
  "voc(v):": "voc",
  "isc(ma):": "isc",
  "vpmax(v):": "vmax",
  "ipmax(ma):": "imax",
  "pmax(mw):": "pmax",
  "efficiency(%):": "pce",
  "fillfactor:": "ff",
  "jsc(ma/cm2):": "jsc",
  "rs(ohm):": "rs",
  "rsh(ohm):": "rsh",
};

const CURVE_HEADER = "v(v)";

function normalizeLabel(raw: string): string {
  return raw.replace(/\s+/g, "").toLowerCase();
}

function readDirection(raw: string): ScanDirection | null {
  const v = raw.trim().toLowerCase();
  if (v.startsWith("rev")) return "REVERSE";
  if (v.startsWith("for") || v.startsWith("fwd")) return "FORWARD";
  return null;
}

function readCondition(raw: string): TestCondition | null {
  const v = raw.trim().toLowerCase();
  if (v.startsWith("light")) return "LIGHT";
  if (v.startsWith("dark")) return "DARK";
  return null;
}

/** "Date and Time:2026/08/20-14:30:40" */
function readTimestamp(raw: string, tzOffsetMinutes: number): Date | null {
  const m = raw.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})[-\s]+(\d{1,2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return wallClockToDate(
    Number(m[1]), Number(m[2]), Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6]),
    tzOffsetMinutes,
  );
}

export function parseGiantForce(grid: string[][], tzOffsetMinutes: number): ParsedJvFile {
  const warnings: string[] = [];

  // Each scan occupies three columns (V, I, P). Locate them by the curve header.
  let headerRow = -1;
  for (let r = 0; r < grid.length && headerRow < 0; r++) {
    if (grid[r].some((c) => c.trim().toLowerCase() === CURVE_HEADER)) headerRow = r;
  }
  if (headerRow < 0) {
    throw new UnsupportedInstrumentFile(
      "No V/I curve in this file. Looks like a GiantForce \"Save table\" export — " +
        "those only repeat metrics that the auto-saved per-pixel files already carry.",
    );
  }
  const blockCols = grid[headerRow]
    .map((c, i) => (c.trim().toLowerCase() === CURVE_HEADER ? i : -1))
    .filter((i) => i >= 0);

  const scans: JvScan[] = [];
  for (const c of blockCols) {
    const meta: Record<string, string> = {};
    let measuredAt: Date | null = null;

    for (let r = 0; r < headerRow; r++) {
      const label = cell(grid, r, c);
      if (!label) continue;
      if (/^date and time/i.test(label)) {
        measuredAt = readTimestamp(label, tzOffsetMinutes);
        continue;
      }
      const key = LABELS[normalizeLabel(label)];
      // Bare numbers under "Sample Area" are per-pixel area echoes — skip them.
      if (key) meta[key] = cell(grid, r, c + 1);
    }

    const serial = (meta.serial ?? "").trim();
    if (!serial) {
      warnings.push(`Skipped a scan at column ${c + 1}: no "Serial NO." was entered on the instrument.`);
      continue;
    }

    const area = num(meta.area);
    const curve: CurvePoint[] = [];
    for (let r = headerRow + 1; r < grid.length; r++) {
      const v = num(cell(grid, r, c));
      const i = num(cell(grid, r, c + 1));
      if (v === undefined || i === undefined) {
        if (isNumeric(cell(grid, r, c))) continue;
        break;
      }
      const p = num(cell(grid, r, c + 2));
      curve.push({ v, i, p: p ?? v * i, j: area ? i / area : undefined });
    }
    if (!curve.length) {
      warnings.push(`Skipped "${serial}": the curve section was empty.`);
      continue;
    }

    const settings: JvScan["settings"] = {};
    for (const k of ["startVoltage", "stopVoltage", "scanSpeed", "testMode"] as const) {
      if (meta[k]) settings[k] = num(meta[k]) ?? meta[k];
    }
    settings.points = curve.length;

    scans.push({
      serial,
      direction: readDirection(meta.direction ?? ""),
      condition: readCondition(meta.condition ?? ""),
      measuredAt,
      operator: (meta.operator ?? "").trim(),
      material: (meta.material ?? "").trim(),
      metrics: {
        voc: num(meta.voc),
        isc: num(meta.isc),
        jsc: num(meta.jsc),
        pmax: num(meta.pmax),
        vmax: num(meta.vmax),
        imax: num(meta.imax),
        pce: num(meta.pce),
        ff: num(meta.ff),
        rs: num(meta.rs),
        rsh: num(meta.rsh),
        area,
      },
      curve,
      settings,
    });
  }

  if (!scans.length) throw new UnsupportedInstrumentFile("No usable scans found in this GiantForce file.");
  return { instrument: "GIANTFORCE_IV", scans, warnings };
}
