import { readFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";

const xml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
export function chemicalWorkbook(
  rows: (string | number | null)[][],
  headers = ["Molecule name", "SMILES"],
) {
  const files = unzipSync(
    readFileSync(
      path.join(
        process.cwd(),
        "src/infrastructure/chemistry/assets/sam-upload-template.xlsx",
      ),
    ),
  );
  const values = [headers, ...rows];
  const data = values
    .map(
      (row, index) =>
        `<row r="${index + 1}">${row
          .map((value, col) =>
            value === null
              ? ""
              : typeof value === "number"
                ? `<c r="${String.fromCharCode(65 + col)}${index + 1}"><v>${value}</v></c>`
                : `<c r="${String.fromCharCode(65 + col)}${index + 1}" t="inlineStr"><is><t>${xml(value)}</t></is></c>`,
          )
          .join("")}</row>`,
    )
    .join("");
  files["xl/worksheets/sheet1.xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${data}</sheetData></worksheet>`,
  );
  return zipSync(files);
}

export function changeWorkbook(
  bytes: Uint8Array,
  key: string,
  change: (text: string) => string,
) {
  const files = unzipSync(bytes);
  files[key] = strToU8(change(strFromU8(files[key] ?? new Uint8Array())));
  return zipSync(files);
}

/** A valid, larger XLSX: incompressible synthetic text on the non-imported sheet. */
export function largeChemicalWorkbook(rows: (string | number | null)[][]) {
  const files = unzipSync(chemicalWorkbook(rows));
  const padding = randomBytes(5 * 512 * 1024).toString("base64");
  const chunks = padding.match(/.{1,30000}/g)!;
  files["xl/worksheets/sheet2.xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${chunks.map((text, index) => `<row r="${index + 1}"><c r="A${index + 1}" t="inlineStr"><is><t>${text}</t></is></c></row>`).join("")}</sheetData></worksheet>`,
  );
  return zipSync(files);
}
