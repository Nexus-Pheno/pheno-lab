import { describe, expect, it } from "vitest";
import { isScientificSample, resultGroupLabels } from "./results";

describe("result groups", () => {
  it("keeps empty planned groups and excludes the Trash/Error bucket", () => {
    expect(
      resultGroupLabels(
        [{ label: "A" }, { label: "B" }],
        [
          { variationGroup: "A" },
          { variationGroup: "ERROR" },
          { variationGroup: null },
        ],
      ),
    ).toEqual(["A", "B"]);
  });

  it("filters reserved groups when no plan metadata exists", () => {
    expect(
      resultGroupLabels(undefined, [
        { variationGroup: "B" },
        { variationGroup: "ERROR" },
        { variationGroup: "A" },
      ]),
    ).toEqual(["A", "B"]);
    expect(isScientificSample({ variationGroup: "ERROR" })).toBe(false);
    expect(isScientificSample({ variationGroup: "EXTRA" })).toBe(false);
    expect(isScientificSample({ variationGroup: null })).toBe(true);
  });
});
