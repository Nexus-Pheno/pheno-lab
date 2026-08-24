import { describe, expect, it } from "vitest";
import { normalizeSerial } from "./normalize";
import { aliasesOf, sampleSerial, serialsFor, shortCodeFor } from "./serial";

describe("instrument serials", () => {
  it("normalizes full-width input and separators", () => {
    expect(normalizeSerial("  Ｅ７＿ｓ５ － ２ ")).toBe("E7-S5-2");
  });

  it("creates stable short sample serials", () => {
    expect(shortCodeFor(12)).toBe("E12");
    expect(sampleSerial("E12", "S5")).toBe("E12-S5");
  });

  it("normalizes and de-duplicates aliases", () => {
    expect(serialsFor("E12", "S5", ["cell_17", "CELL-17", "E12-S5"])).toEqual([
      "E12-S5",
      "CELL-17",
    ]);
    expect(aliasesOf(["E12-S5", "CELL-17"], "E12", "S5")).toEqual(["CELL-17"]);
  });
});
