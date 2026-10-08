import { describe, expect, it } from "vitest";
import { testPlanSchema } from "./schema";

describe("test plan group occupancy", () => {
  const groups = [{ label: "A", samples: 0, isControl: true }];
  it("allows an empty group when substrates are allocated separately", () => {
    expect(
      testPlanSchema.safeParse({
        groups,
        substrates: { count: 17 },
        variables: [],
      }).success,
    ).toBe(true);
  });
  it("still requires positive group counts for legacy count-based plans", () => {
    expect(testPlanSchema.safeParse({ groups, variables: [] }).success).toBe(
      false,
    );
    expect(
      testPlanSchema.safeParse({
        groups: [{ ...groups[0], samples: 3 }],
        variables: [],
      }).success,
    ).toBe(true);
  });
  it("rejects negative counts and retains the protected batch limit", () => {
    expect(
      testPlanSchema.safeParse({
        groups: [{ ...groups[0], samples: -1 }],
        substrates: { count: 17 },
        variables: [],
      }).success,
    ).toBe(false);
    expect(
      testPlanSchema.safeParse({
        groups,
        substrates: { count: 199 },
        variables: [],
      }).success,
    ).toBe(false);
  });
  it("accepts the editor's unselected optional equipment without weakening ID validation", () => {
    const plan = {
      groups,
      substrates: { count: 17 },
      variables: [
        {
          kind: "parameter",
          processId: "process-1",
          equipmentId: "",
          parameter: "Spin speed",
          unit: "rpm",
          values: { A: "1000" },
        },
      ],
    };
    expect(testPlanSchema.parse(plan).variables[0].equipmentId).toBeUndefined();
    expect(
      testPlanSchema.safeParse({
        ...plan,
        variables: [{ ...plan.variables[0], equipmentId: "x".repeat(129) }],
      }).success,
    ).toBe(false);
  });
});
