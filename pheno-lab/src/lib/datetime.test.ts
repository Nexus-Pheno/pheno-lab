import { describe, expect, it } from "vitest";
import { fmtBeijing } from "./datetime";

describe("fmtBeijing", () => {
  it("renders UTC instants as Beijing wall-clock time", () => {
    // 23:30 UTC = 07:30 next day in Beijing — the date must roll over.
    const utcEvening = new Date("2026-09-07T23:30:00Z");
    expect(fmtBeijing(utcEvening)).toBe("2026-09-08 07:30");
    expect(fmtBeijing(utcEvening, "date")).toBe("2026-09-08");
  });

  it("keeps mid-day times on the same date", () => {
    expect(fmtBeijing(new Date("2026-09-08T04:05:00Z"))).toBe(
      "2026-09-08 12:05",
    );
  });
});
