import { describe, expect, it } from "vitest";
import { championPce, digestWindow } from "./digest";

describe("morning digest", () => {
  it("uses the previous calendar day in Asia/Shanghai", () => {
    expect(digestWindow(new Date("2026-09-07T00:30:00Z"))).toEqual({
      date: "2026-09-07",
      start: new Date("2026-09-05T16:00:00Z"),
      end: new Date("2026-09-06T16:00:00Z"),
    });
    expect(digestWindow(new Date("2026-09-06T16:01:00Z")).date).toBe(
      "2026-09-07",
    );
  });
  it("excludes missing, nonnumeric and invalid PCE values", () => {
    expect(
      championPce([
        { metrics: null },
        { metrics: {} },
        { metrics: { pce: "25" } },
        { metrics: { pce: 101 } },
        { metrics: { pce: -2 } },
        { metrics: { pce: Infinity } },
      ]),
    ).toBeNull();
    expect(
      championPce([
        { metrics: { pce: 0 } },
        { metrics: { pce: 20.123 } },
        { metrics: { pce: 21.56 } },
      ]),
    ).toBe(21.56);
  });
});
