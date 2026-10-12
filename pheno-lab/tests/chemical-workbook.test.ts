import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { readSamWorkbook } from "@/infrastructure/chemistry/workbook";
import { chemicalWorkbook, changeWorkbook } from "./helpers/chemical-workbook";

describe("bounded SAM Excel workbook parser", () => {
  it("keeps the real download template blank and its public reference on the instructions sheet", async () => {
    const template = await readFile(
      "src/infrastructure/chemistry/assets/sam-upload-template.xlsx",
    );
    await expect(
      readSamWorkbook(template, "template.xlsx"),
    ).rejects.toMatchObject({ code: "empty" });
  });
  it("reads literal names/SMILES and preserves Excel row numbers across blank rows", async () => {
    const rows = await readSamWorkbook(
      chemicalWorkbook([
        ["First", "CCO"],
        [null, null],
        ["第二材料", "c1ccccc1"],
      ]),
      "input.xlsx",
    );
    expect(rows).toMatchObject([
      { row: 2, cells: ["First", "CCO"] },
      { row: 4, cells: ["第二材料", "c1ccccc1"] },
    ]);
  });
  it.each([101, 1001, 5001])(
    "reads all %i material rows without the former row/cell caps",
    async (count) => {
      const entries = await readSamWorkbook(
        chemicalWorkbook(
          Array.from({ length: count }, (_, index) => [
            `Fixture${index}`,
            "CCO",
          ]),
        ),
        "larger.xlsx",
      );
      expect(entries).toHaveLength(count);
      expect(entries[0]).toMatchObject({ row: 2, cells: ["Fixture0", "CCO"] });
      expect(entries.at(-1)).toMatchObject({
        row: count + 1,
        cells: [`Fixture${count - 1}`, "CCO"],
      });
    },
  );
  it("rejects formulas, extra headers, macros, XML entities and unsafe worksheet allocations", async () => {
    const file = chemicalWorkbook([["Fixture", "CCO"]]);
    for (const bytes of [
      chemicalWorkbook(
        [["Fixture", "CCO", "x"]],
        ["Molecule name", "SMILES", "Supplier"],
      ),
      changeWorkbook(file, "xl/worksheets/sheet1.xml", (text) =>
        text.replace("<is><t>CCO</t></is>", '<f>"CCO"</f><v>CCO</v>'),
      ),
      changeWorkbook(file, "xl/vbaProject.bin", () => "synthetic macro"),
      changeWorkbook(
        file,
        "xl/worksheets/sheet1.xml",
        (text) => '<!DOCTYPE worksheet [<!ENTITY x "synthetic">]>' + text,
      ),
      changeWorkbook(file, "xl/worksheets/sheet1.xml", (text) =>
        text.replace('r="A2"', 'r="A1048577"'),
      ),
      changeWorkbook(file, "xl/worksheets/sheet1.xml", (text) =>
        text.replace('r="A2"', 'r="ZZ5000"'),
      ),
    ])
      await expect(readSamWorkbook(bytes, "input.xlsx")).rejects.toThrow();
    await expect(readSamWorkbook(file, "input.xls")).rejects.toThrow();
    await expect(
      readSamWorkbook(new Uint8Array(2 * 1024 * 1024 + 1), "input.xlsx"),
    ).rejects.toMatchObject({ code: "file" });
  });
});
