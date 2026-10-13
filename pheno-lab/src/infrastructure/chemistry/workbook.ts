import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { readSheet } from "read-excel-file/node";

export const MAX_CHEMICAL_FILE_BYTES = 5 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 4 * MAX_CHEMICAL_FILE_BYTES;
// Bound sparse-sheet allocation, independently of the number of material rows.
const MAX_SHEET_CELLS = 2 * 1024 * 1024;
export class ChemicalWorkbookError extends Error {
  constructor(
    public readonly code: "file" | "limits" | "columns" | "formulas" | "empty",
  ) {
    super("The workbook could not be imported.");
  }
}

export async function readSamTemplate() {
  return readFile(
    path.join(
      process.cwd(),
      "src/infrastructure/chemistry/assets/sam-upload-template.xlsx",
    ),
  );
}

/** Bounded OOXML only. No formula evaluation, macros, external links or disk extraction. */
export async function readSamWorkbook(bytes: Uint8Array, filename: string) {
  if (
    !filename.toLowerCase().endsWith(".xlsx") ||
    !bytes.length ||
    bytes.length > MAX_CHEMICAL_FILE_BYTES
  )
    throw new ChemicalWorkbookError("file");
  let expanded = 0;
  const names = new Set<string>();
  try {
    const files = unzipSync(bytes, {
      filter: (file) => {
        expanded += file.originalSize;
        if (
          names.has(file.name) ||
          file.name.includes("..") ||
          file.name.startsWith("/") ||
          names.size >= 200 ||
          file.originalSize > MAX_CHEMICAL_FILE_BYTES ||
          expanded > MAX_EXPANDED_BYTES
        )
          throw new ChemicalWorkbookError("limits");
        names.add(file.name);
        if (/vbaProject|activeX|externalLinks|embeddings/i.test(file.name))
          throw new ChemicalWorkbookError("file");
        return true;
      },
    });
    if (!files["xl/workbook.xml"] || !files["[Content_Types].xml"])
      throw new ChemicalWorkbookError("file");
    for (const [name, data] of Object.entries(files)) {
      if (!/\.(xml|rels)$/.test(name)) continue;
      const text = strFromU8(data);
      if (/<!DOCTYPE|<!ENTITY|TargetMode\s*=\s*["']External/i.test(text))
        throw new ChemicalWorkbookError("file");
      if (name.startsWith("xl/worksheets/")) {
        if (/<(?:[a-z0-9_]+:)?f[\s/>]/i.test(text))
          throw new ChemicalWorkbookError("formulas");
        let maxRow = 0;
        let maxColumn = 0;
        for (const match of text.matchAll(
          /<(?:[a-z0-9_]+:)?c\b[^>]*\br=["']([A-Z]+)(\d+)["']/gi,
        )) {
          const row = Number(match[2]);
          if (match[1].length > 2 || row < 1 || row > 1048576)
            throw new ChemicalWorkbookError("limits");
          const column = [...match[1].toUpperCase()].reduce(
            (value, letter) => value * 26 + letter.charCodeAt(0) - 64,
            0,
          );
          maxRow = Math.max(maxRow, row);
          maxColumn = Math.max(maxColumn, column);
        }
        for (const match of text.matchAll(
          /<(?:[a-z0-9_]+:)?row\b[^>]*\br=["'](\d+)["']/gi,
        )) {
          const row = Number(match[1]);
          if (row < 1 || row > 1048576)
            throw new ChemicalWorkbookError("limits");
          maxRow = Math.max(maxRow, row);
        }
        if (maxRow * Math.max(maxColumn, 1) > MAX_SHEET_CELLS)
          throw new ChemicalWorkbookError("limits");
      }
    }
    const rows = await readSheet(Buffer.from(bytes), "SAM Materials", {
      trim: false,
    });
    const header = rows[0] ?? [];
    const nameHeader =
      typeof header[0] === "string" ? header[0].trim().toLowerCase() : "";
    if (
      ![
        "molecule name",
        "material name",
        "name",
        "分子名称",
        "材料名称",
      ].includes(nameHeader) ||
      typeof header[1] !== "string" ||
      header[1].trim().toLowerCase() !== "smiles" ||
      header.slice(2).some((value) => value !== null && value !== "")
    )
      throw new ChemicalWorkbookError("columns");
    const entries = rows
      .slice(1)
      .map((cells, index) => ({ row: index + 2, cells }))
      .filter(({ cells }) =>
        cells.some(
          (value) =>
            value !== null &&
            value !== "" &&
            !(typeof value === "string" && !value.trim()),
        ),
      );
    if (!entries.length) throw new ChemicalWorkbookError("empty");
    return entries;
  } catch (error) {
    if (error instanceof ChemicalWorkbookError) throw error;
    throw new ChemicalWorkbookError("file");
  }
}
