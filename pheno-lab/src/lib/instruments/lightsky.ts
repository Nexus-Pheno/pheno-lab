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

/**
 * Trace names and summary names come from two different fields in the LabVIEW
 * software, and operators don't always type them the same way — one real
 * session named its traces "2026-001-26-2-S25-8-Rev" (full serial) but its
 * summary rows "13A25-8-Rev" (sim-code style), so the exact-name join failed
 * and every scan lost its Voc/PCE. Both styles end in
 * <sample number>-<pixel>, so that plus the direction makes a structural key
 * for a fallback pairing when exact names don't line up.
 */
function canonicalKey(name: string): string | null {
  const { serial, direction } = splitDirection(name.trim());
  const m =
    serial.match(/[sS](\d{1,3})-(\d{1,3})$/) ?? // …-S25-8 (full serial)
    serial.match(/^\d{1,2}[a-zA-Z](\d{1,3})-(\d{1,3})$/); // 13A25-8 (sim code)
  if (!m) return null;
  return `s${Number(m[1])}-${Number(m[2])}-${direction ?? ""}`;
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
  //
  // A session routinely holds SEVERAL scans of one cell in one direction, so
  // the trace name is NOT unique — "0820-15-8-Rev" can appear three times.
  // Keep every row per name, in file order, and pair the Nth curve block with
  // the Nth summary row of that name. Keying by name alone silently gave every
  // repeat the last row's Voc/PCE and discarded the others.
  const summary = new Map<string, Record<string, string>[]>();
  // Same rows again under the structural key, for the fuzzy fallback.
  const byCanonical = new Map<
    string,
    { names: Set<string>; rows: Record<string, string>[] }
  >();
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
      const forName = summary.get(name);
      if (forName) forName.push(row);
      else summary.set(name, [row]);
      const ck = canonicalKey(name);
      if (ck) {
        const entry = byCanonical.get(ck) ?? { names: new Set(), rows: [] };
        entry.names.add(name);
        entry.rows.push(row);
        byCanonical.set(ck, entry);
      }
    }
  } else {
    warnings.push(
      "This file has no summary table, so Voc/Jsc/PCE could not be read — curves only.",
    );
  }

  const { year, month, day } = wallClockParts(fileDate, tzOffsetMinutes);

  const scans: JvScan[] = [];
  // How many blocks of each claim key have already taken a summary row.
  const claimed = new Map<string, number>();
  const fuzzyWarned = new Set<string>();
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

    // Exact name first; else the structural key — but only when it maps to a
    // single summary name, so metrics can never cross between two cells.
    let rows = summary.get(name);
    let claimKey = name;
    if (!rows) {
      const ck = canonicalKey(name);
      const entry = ck ? byCanonical.get(ck) : undefined;
      if (entry && entry.names.size === 1) {
        rows = entry.rows;
        claimKey = ck!;
        if (!fuzzyWarned.has(name)) {
          fuzzyWarned.add(name);
          warnings.push(
            `Trace "${name}" matched summary row "${[...entry.names][0]}" by sample/pixel number — the two name fields disagree in this file.`,
          );
        }
      }
    }
    const nth = claimed.get(claimKey) ?? 0;
    claimed.set(claimKey, nth + 1);
    const s = rows?.[nth];
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
        nth > 0
          ? `"${name}" appears ${nth + 1} times but the summary table lists it ${rows?.length ?? 0} time(s), so this repeat has no Voc/PCE.`
          : `"${name}" has a curve but no summary row — it was probably not ticked before saving.`,
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
