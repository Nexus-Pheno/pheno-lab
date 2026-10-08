import { describe, expect, it } from "vitest";
import { substrateCounts, testPlanGroupLabels } from "./test-plan";

describe("planned groups and physical occupancy", () => {
  it("keeps defined empty groups in plan order", () => {
    expect(
      testPlanGroupLabels(
        {
          groups: [
            { label: "B", samples: 0, isControl: false },
            { label: "A", samples: 0, isControl: true },
          ],
        },
        [{ variationGroup: null }],
      ),
    ).toEqual(["B", "A"]);
  });

  it("supports old plans without treating spare and problem pools as variables", () => {
    expect(
      testPlanGroupLabels(null, [
        { variationGroup: "B" },
        { variationGroup: "A" },
        { variationGroup: "ERROR" },
        { variationGroup: "EXTRA" },
        { variationGroup: null },
        { variationGroup: "B" },
      ]),
    ).toEqual(["A", "B"]);
  });

  it("counts the full batch without inventing occupants for empty groups", () => {
    expect(
      substrateCounts(
        ["A", "B", "C", "D", "E"].map((label) => ({ label })),
        17,
      ),
    ).toEqual({
      total: 17,
      grouped: 0,
      extras: 17,
      errors: 0,
      byGroup: { A: 0, B: 0, C: 0, D: 0, E: 0 },
    });
  });

  it("counts assignments once, ignoring stale assignments outside the batch", () => {
    expect(
      substrateCounts([{ label: "A" }, { label: "B" }], 5, {
        S1: "A",
        S2: "B",
        S3: "ERROR",
        S4: "deleted group",
        S6: "A",
      }),
    ).toEqual({
      total: 5,
      grouped: 2,
      extras: 2,
      errors: 1,
      byGroup: { A: 1, B: 1 },
    });
  });
});
