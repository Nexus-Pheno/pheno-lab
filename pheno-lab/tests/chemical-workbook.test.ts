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
  it("rejects formulas, extra headers, macros, XML entities and oversized row indexes", async () => {
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
        text.replace('r="A2"', 'r="A1048576"'),
      ),
      chemicalWorkbook(
        Array.from({ length: 101 }, (_, index) => [`Fixture${index}`, "CCO"]),
      ),
    ])
      await expect(readSamWorkbook(bytes, "input.xlsx")).rejects.toThrow();
    await expect(readSamWorkbook(file, "input.xls")).rejects.toThrow();
  });
});
