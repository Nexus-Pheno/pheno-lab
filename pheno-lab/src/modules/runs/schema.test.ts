import { describe, expect, it } from "vitest";
import { executionBatchSchema, objectKeySchema } from "./schema";

describe("capture schemas", () => {
  it("rejects duplicate samples and unbounded notes", () => {
    expect(
      executionBatchSchema.safeParse({
        runId: "run-1",
        stepId: "step-1",
        sampleIds: ["sample-1", "sample-1"],
        data: {
          actuals: {},
          environmentConditions: {},
          note: "ok",
          flagged: false,
        },
      }).success,
    ).toBe(false);
  });

  it("accepts safe object keys and rejects traversal", () => {
    expect(
      objectKeySchema.safeParse(
        "organizations/org/users/user/images/2026/08/photo.png",
      ).success,
    ).toBe(true);
    expect(objectKeySchema.safeParse("../secret").success).toBe(false);
  });
});
