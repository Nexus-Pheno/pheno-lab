import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseInstrumentFile, UnsupportedInstrumentFile } from ".";

const fixtures = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
);
const fixture = (name: string) => readFileSync(path.join(fixtures, name));

describe("instrument parser fixtures", () => {
  it("parses a GiantForce auto-saved pixel", () => {
    const parsed = parseInstrumentFile(fixture("giantforce-auto-single.csv"), {
      fileName: "C1-1_Cindy_perovskite_Light_Normal_Rev_1_143040.csv",
    });
    expect(parsed.instrument).toBe("GIANTFORCE_IV");
    expect(parsed.warnings).toEqual([]);
    expect(parsed.scans).toHaveLength(1);
    expect(parsed.scans[0]).toMatchObject({
      serial: "C1-1",
      operator: "Cindy",
      material: "perovskite",
      direction: "REVERSE",
      condition: "LIGHT",
      metrics: {
        voc: 1.158118,
        jsc: 25.183943,
        pce: 25.804105,
        ff: 88.47329,
        area: 0.04,
      },
    });
    expect(parsed.scans[0].curve).toHaveLength(101);
    expect(parsed.scans[0].measuredAt?.toISOString()).toBe(
      "2026-08-20T06:30:40.000Z",
    );
  });

  it("parses all four GiantForce manual data scans", () => {
    const parsed = parseInstrumentFile(fixture("giantforce-manual-data.csv"), {
      fileName: "C2-2_Cindy_Data_20260820143458.csv",
    });
    expect(parsed.scans.map((scan) => scan.serial)).toEqual([
      "C1-1",
      "C1-2",
      "C2-1",
      "C2-2",
    ]);
    expect(parsed.scans.every((scan) => scan.curve.length === 101)).toBe(true);
    expect(parsed.scans.map((scan) => scan.metrics.pce)).toEqual([
      25.804105, 25.498632, 25.324962, 25.463331,
    ]);
  });

  it("rejects GiantForce's summary-only table export", () => {
    expect(() =>
      parseInstrumentFile(fixture("giantforce-manual-table.csv"), {
        fileName: "C2-2_Cindy_Table_20260820143644.csv",
      }),
    ).toThrow(UnsupportedInstrumentFile);
  });

  it("parses a LIGHTSKY session and normalizes photocurrent sign", () => {
    const parsed = parseInstrumentFile(fixture("lightsky-session.csv"), {
      fileName: "123.xls",
      sourceDir: "D:\\Lily\\2026",
      fileModifiedAt: new Date("2026-08-20T07:40:00Z"),
    });
    expect(parsed.instrument).toBe("LIGHTSKY_LIV");
    expect(parsed.scans.map((scan) => scan.serial)).toEqual([
      "06-8",
      "05-8",
      "10-8",
    ]);
    expect(parsed.scans[0].settings).toMatchObject({
      traceName: "06-8-Rev",
      signFlipped: true,
    });
    expect(parsed.scans[0].metrics).toMatchObject({
      voc: 11.5126772709,
      jsc: 2.2291051644,
      pce: 18.2093523267,
      ff: 70.9557525495,
      area: 63.18,
    });
    expect(parsed.scans[0].curve).toHaveLength(119);
  });

  it("keeps every repeat when one cell is scanned twice in the same direction", () => {
    // A LIGHTSKY session routinely holds several scans of one cell in one
    // direction, so the trace name repeats. Keying the summary table by name
    // alone gave every repeat the LAST row's Voc/PCE and dropped the rest —
    // two real measurements silently replaced by a copy of a third.
    const parsed = parseInstrumentFile(fixture("lightsky-repeated-trace.csv"), {
      fileName: "session.csv",
      fileModifiedAt: new Date("2026-08-27T02:13:00Z"),
    });
    expect(parsed.instrument).toBe("LIGHTSKY_LIV");
    expect(parsed.scans).toHaveLength(3);
    expect(parsed.scans.map((s) => s.serial)).toEqual(["A1", "A1", "A1"]);
    expect(parsed.scans.map((s) => s.direction)).toEqual([
      "REVERSE",
      "REVERSE",
      "FORWARD",
    ]);

    // Each block takes its OWN summary row, in file order — not the last one.
    expect(parsed.scans.map((s) => s.metrics.voc)).toEqual([2.0, 1.9, 1.8]);
    expect(parsed.scans.map((s) => s.metrics.pce)).toEqual([19.9, 18.8, 17.5]);

    // The pairing is verifiable from the curves themselves: the voltage where
    // each trace crosses zero current must match the Voc it was given.
    for (const scan of parsed.scans) {
      const crossing = scan.curve.find((p, i) => {
        const next = scan.curve[i + 1];
        return next !== undefined && p.i >= 0 !== next.i >= 0;
      });
      expect(crossing).toBeDefined();
      expect(Math.abs(crossing!.v - scan.metrics.voc!)).toBeLessThan(0.15);
    }
  });
});
