import { UnsupportedInstrumentFile } from "./types";

/**
 * Both rigs write CRLF CSV. GiantForce auto-saves are pure ASCII, but every
 * summary/table export is GBK (that is why η and ² show up as mojibake when
 * opened as UTF-8), so sniff rather than assume.
 */
export function decodeLabText(buf: Buffer): string {
  if (buf.length >= 4) {
    if (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0)
      throw new UnsupportedInstrumentFile("This is a real Excel .xls workbook, not the instrument's CSV export.");
    if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04)
      throw new UnsupportedInstrumentFile("This is a zip/xlsx file, not the instrument's CSV export.");
  }
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(buf.subarray(3));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("gbk").decode(buf);
  }
}

/** Minimal quote-aware CSV split. Trailing all-empty columns are kept — the
 *  parsers index by column, so padding must not shift anything. */
export function parseCsvGrid(text: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.split(/\r?\n/)) {
    const cells: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            cur += '"';
            i++;
          } else quoted = false;
        } else cur += ch;
      } else if (ch === '"') {
        quoted = true;
      } else if (ch === ",") {
        cells.push(cur);
        cur = "";
      } else cur += ch;
    }
    cells.push(cur);
    rows.push(cells);
  }
  return rows;
}

export function cell(grid: string[][], r: number, c: number): string {
  return (grid[r]?.[c] ?? "").trim();
}

/** Number or undefined — instrument files pad with spaces and stray blanks. */
export function num(raw: string | undefined): number | undefined {
  if (raw == null) return undefined;
  const s = raw.trim();
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

export function isNumeric(raw: string | undefined): boolean {
  return num(raw) !== undefined;
}
