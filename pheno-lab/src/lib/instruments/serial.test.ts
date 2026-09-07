import { describe, expect, it } from "vitest";
import { canonicalSerialKey, normalizeSerial } from "./normalize";
import { aliasesOf, sampleSerial, serialsFor, shortCodeFor } from "./serial";

describe("instrument serials", () => {
  it("normalizes full-width input and separators", () => {
    expect(normalizeSerial("  Ｅ７＿ｓ５ － ２ ")).toBe("E7-S5-2");
  });

  it("canonical key ignores zero padding but keeps zero itself", () => {
    // The 2026-09-04 incident: 26A010 typed on the rig for sample 26A10.
    expect(canonicalSerialKey("26A010")).toBe("26A10");
    expect(canonicalSerialKey("26A010-3-Rev")).toBe("26A10-3-REV");
    expect(canonicalSerialKey("26A10")).toBe("26A10");
    expect(canonicalSerialKey("2026-001-26-3-S010")).toBe("2026-1-26-3-S10");
    expect(canonicalSerialKey("A0")).toBe("A0");
    expect(canonicalSerialKey("cell_017")).toBe("CELL-17");
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
