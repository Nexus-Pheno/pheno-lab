// LIGHTSKY "Solar Cell Measurement Software" (LabVIEW Liv-2020) driving the
// LSS-200 — the 大太阳 large-area module simulator.
//
// No auto-save: the operator ticks rows and clicks Save, producing ONE file per
// session that holds every selected trace side by side (three columns each:
// V / Jsc / Isc) followed by a summary table of the same traces.
//
// Two traps this parser handles:
//  · the file is GBK and its Date column carries a TIME ONLY — the calendar date
//    must come from the caller (the agent stamps it when the file is written)
//  · photocurrent is written NEGATIVE here and POSITIVE by GiantForce, so the
//    curve is sign-normalized to the GiantForce convention

import { cell, isNumeric, num } from "./csv";
import { wallClockParts, wallClockToDate } from "./time";
import type {
  CurvePoint,
  JvMetrics,
  JvScan,
  ParsedJvFile,
  ScanDirection,
} from "./types";
import { UnsupportedInstrumentFile } from "./types";

/** "Jsc (mA/cm^2)" → "jsc", "Rsh （ohm）" → "rsh" */
function headerKey(raw: string): string {
  return raw
    .split(/[(（]/)[0]
    .replace(/[^a-z]/gi, "")
    .toLowerCase();
}

function splitDirection(name: string): {
  serial: string;
  direction: ScanDirection | null;
} {
  const m = name.match(/^(.*)-(rev|for|fwd)$/i);
  if (!m) return { serial: name, direction: null };
  const tag = m[2].toLowerCase();
  return { serial: m[1], direction: tag === "rev" ? "REVERSE" : "FORWARD" };
}

export function parseLightSky(
  grid: string[][],
  fileDate: Date,
  tzOffsetMinutes: number,
): ParsedJvFile {
  const warnings: string[] = [];

  const blockCols =
    grid[0]
      ?.map((c, i) => (c.trim().toLowerCase() === "name" ? i : -1))
      .filter((i) => i >= 0) ?? [];
  if (!blockCols.length)
    throw new UnsupportedInstrumentFile(
      "No LIGHTSKY trace blocks found in this file.",
    );

  // ---- summary table: a later row whose second cell is "Name" ----
  const summary = new Map<string, Record<string, string>>();
  let summaryRow = -1;
  for (let r = 1; r < grid.length; r++) {
    if (cell(grid, r, 1).toLowerCase() === "name") {
      summaryRow = r;
      break;
    }
  }
  if (summaryRow >= 0) {
    const keys = grid[summaryRow].map(headerKey);
    for (let r = summaryRow + 1; r < grid.length; r++) {
      const name = cell(grid, r, 1);
      if (!name) continue;
      const row: Record<string, string> = {};
      keys.forEach((k, i) => {
        if (k) row[k] = cell(grid, r, i);
      });
      summary.set(name, row);
    }
  } else {
    warnings.push(
      "This file has no summary table, so Voc/Jsc/PCE could not be read — curves only.",
    );
  }

  const { year, month, day } = wallClockParts(fileDate, tzOffsetMinutes);

  const scans: JvScan[] = [];
  for (const c of blockCols) {
    const name = cell(grid, 0, c + 2);
    if (!name) {
      warnings.push(`Skipped the trace at column ${c + 1}: it has no name.`);
      continue;
    }

    // Columns are V, Jsc, Isc — note the current is the THIRD column here.
    const raw: CurvePoint[] = [];
    for (let r = 2; r < grid.length; r++) {
      const v = num(cell(grid, r, c));
      const j = num(cell(grid, r, c + 1));
      const i = num(cell(grid, r, c + 2));
      if (v === undefined || i === undefined) {
        if (isNumeric(cell(grid, r, c))) continue;
        break;
      }
      raw.push({ v, i, j });
    }
    if (!raw.length) {
      warnings.push(`Skipped "${name}": the curve section was empty.`);
      continue;
    }

    // Normalize sign against the current nearest 0 V.
    const atZero = raw.reduce(
      (best, p) => (Math.abs(p.v) < Math.abs(best.v) ? p : best),
      raw[0],
    );
    const flip = atZero.i < 0;
    const curve: CurvePoint[] = raw.map(({ v, i, j }) => {
      const ii = flip ? -i : i;
      const jj = j === undefined ? undefined : flip ? -j : j;
      return { v, i: ii, j: jj, p: v * ii };
    });

    const s = summary.get(name);
    const metrics: JvMetrics = s
      ? {
          voc: num(s.voc),
          isc: num(s.isc),
          jsc: num(s.jsc),
          pmax: num(s.pmax),
          vmax: num(s.vmax),
          imax: num(s.imax),
          pce: num(s.eff),
          ff: num(s.ff),
          rs: num(s.rs),
          rsh: num(s.rsh),
          area: num(s.area),
        }
      : {};
    if (!s)
      warnings.push(
        `"${name}" has a curve but no summary row — it was probably not ticked before saving.`,
      );

    let measuredAt: Date | null = null;
    const t = (s?.date ?? "").match(/(\d{1,2}):(\d{2}):(\d{2})/);
    if (t) {
      measuredAt = wallClockToDate(
        year,
        month,
        day,
        Number(t[1]),
        Number(t[2]),
        Number(t[3]),
        tzOffsetMinutes,
      );
    }

    const { serial, direction } = splitDirection(name);
    scans.push({
      serial,
      direction,
      // The LabVIEW rig has no light/dark switch in the saved file; every scan
      // we ingest from it is a light IV.
      condition: "LIGHT",
      measuredAt,
      operator: "",
      material: "",
      metrics,
      curve,
      settings: {
        traceName: name,
        points: curve.length,
        signFlipped: flip,
        note: s?.note ?? "",
      },
    });
  }

  if (!scans.length)
    throw new UnsupportedInstrumentFile(
      "No usable traces found in this LIGHTSKY file.",
    );
  return { instrument: "LIGHTSKY_LIV", scans, warnings };
}
