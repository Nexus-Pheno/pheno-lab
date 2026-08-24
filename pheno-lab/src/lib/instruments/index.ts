import { decodeLabText, parseCsvGrid, cell } from "./csv";
import { parseGiantForce } from "./giantforce";
import { parseLightSky } from "./lightsky";
import { LAB_TZ_OFFSET_MINUTES, parseDateFolder, wallClockToDate } from "./time";
import type { InstrumentKind, ParsedJvFile } from "./types";
import { UnsupportedInstrumentFile } from "./types";

export * from "./types";
export { LAB_TZ_OFFSET_MINUTES, parseDateFolder } from "./time";

export type ParseOptions = {
  /** Original name on the lab PC — used to date LIGHTSKY files. */
  fileName: string;
  /** Source folder on the lab PC, e.g. "D:\\IV Measurement System\\Data\\20260820". */
  sourceDir?: string;
  /** File mtime on the lab PC, sent by the agent. Fallback date for LIGHTSKY. */
  fileModifiedAt?: Date;
  /** Force a connector instead of sniffing. */
  instrument?: InstrumentKind;
  tzOffsetMinutes?: number;
};

/** Sniff by shape, never by extension — LIGHTSKY files are often saved as .xls. */
export function detectInstrument(grid: string[][]): InstrumentKind | null {
  if (cell(grid, 0, 0).toLowerCase() === "name" && /^v\s*\(v\)/i.test(cell(grid, 1, 0))) return "LIGHTSKY_LIV";
  if (/^iv test report/i.test(cell(grid, 0, 0))) return "GIANTFORCE_IV";
  for (let r = 0; r < Math.min(grid.length, 60); r++) {
    if (grid[r].some((c) => c.trim().toLowerCase() === "v(v)")) return "GIANTFORCE_IV";
    // The "Save table" export — recognised so the parser can explain the refusal.
    if (cell(grid, r, 0).toLowerCase() === "time/s" && cell(grid, r, 1).toLowerCase() === "serial no.")
      return "GIANTFORCE_IV";
  }
  return null;
}

/**
 * The LIGHTSKY export dates rows by time only. Prefer a date encoded in the
 * path (its folders are per-year, GiantForce's are per-day), else the file's
 * own mtime on the lab PC, else now.
 */
function resolveFileDate(opts: ParseOptions): Date {
  const tz = opts.tzOffsetMinutes ?? LAB_TZ_OFFSET_MINUTES;
  const fromPath = parseDateFolder(opts.sourceDir ?? "") ?? parseDateFolder(opts.fileName);
  if (fromPath) return wallClockToDate(fromPath.year, fromPath.month, fromPath.day, 12, 0, 0, tz);
  return opts.fileModifiedAt ?? new Date();
}

export function parseInstrumentFile(buf: Buffer, opts: ParseOptions): ParsedJvFile {
  const grid = parseCsvGrid(decodeLabText(buf));
  const kind = opts.instrument ?? detectInstrument(grid);
  const tz = opts.tzOffsetMinutes ?? LAB_TZ_OFFSET_MINUTES;
  if (kind === "GIANTFORCE_IV") return parseGiantForce(grid, tz);
  if (kind === "LIGHTSKY_LIV") return parseLightSky(grid, resolveFileDate(opts), tz);
  throw new UnsupportedInstrumentFile(
    `Could not recognise "${opts.fileName}" as a GiantForce or LIGHTSKY export.`,
  );
}
