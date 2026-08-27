import { describe, expect, it } from "vitest";
import { toJvFileRow } from "./measurement-service";

const base = {
  id: "m1",
  serial: "C1-1",
  direction: "REVERSE" as const,
  assignedTo: null,
  measuredAt: new Date("2026-08-27T02:04:31.000Z"),
  metrics: { pce: 19.36, voc: 11.07, jsc: 2.25, ff: 77.55 },
  status: "MATCHED",
  matchNote: "",
  imagePath: null,
  instrument: { name: "小太阳 (GiantForce)" },
  sample: { code: "S1" },
};

describe("toJvFileRow", () => {
  it("carries the operator through to the row the browser renders", () => {
    // The database held "River" on every GiantForce scan, but the row sent to
    // the browser omitted the field entirely, so the instruments page could
    // never show who ran a measurement.
    expect(toJvFileRow({ ...base, operator: "River" }).operator).toBe("River");
  });

  it("keeps an empty operator empty rather than inventing one", () => {
    // The LIGHTSKY rig's file format has no operator column at all.
    expect(toJvFileRow({ ...base, operator: "" }).operator).toBe("");
  });

  it("carries the owner so the page can show who a scan was handed to", () => {
    const owner = { id: "u-river", name: "River" };
    expect(
      toJvFileRow({ ...base, operator: "", assignedTo: owner }).owner,
    ).toEqual(owner);
    expect(toJvFileRow({ ...base, operator: "" }).owner).toBeNull();
  });

  it("drops non-finite metrics to null", () => {
    const row = toJvFileRow({
      ...base,
      operator: "River",
      metrics: { pce: Number.NaN, voc: 11.07 },
    });
    expect(row.pce).toBeNull();
    expect(row.voc).toBe(11.07);
  });
});
