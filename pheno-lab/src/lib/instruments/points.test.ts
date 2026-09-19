import { describe, expect, it } from "vitest";
import { curveDataPoints } from "./points";

describe("curveDataPoints", () => {
  it("counts every (x, y) combination a curve row carries", () => {
    expect(
      curveDataPoints([
        { v: 0, i: 1, j: 2, p: 0 },
        { v: 0.1, i: 0.9, j: 1.8, p: 0.09 },
      ]),
    ).toBe(6);
    expect(curveDataPoints([{ v: 0, i: 1 }])).toBe(1);
  });
  it("is zero for nothing, a bare voltage, or a non-array", () => {
    expect(curveDataPoints([])).toBe(0);
    expect(curveDataPoints([{ v: 0 }])).toBe(0);
    expect(curveDataPoints(null)).toBe(0);
  });
});
