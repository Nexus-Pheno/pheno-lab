import { describe, expect, it } from "vitest";
import { isJvTesting, testingRequestSchema } from "./schema";
import {
  canReadExperiment,
  canManageExperiment,
  canCaptureExperiment,
  canSubmitExperiment,
  assertAdmin,
} from "@/modules/authorization/policy";
import {
  experimentListScope,
  measurementVisibilityScope,
} from "@/modules/authorization/scope";

describe("JV testing boundaries", () => {
  it("recognizes JV stages without including preparation or other characterizations", () => {
    for (const name of [
      "J-V",
      "JV test",
      "J−V",
      "Solar simulator",
      "太阳模拟器",
      "伏安测试",
    ])
      expect(isJvTesting(name)).toBe(true);
    for (const name of ["Spin coating", "Evaporation", "SEM", "XRD"])
      expect(isJvTesting(name)).toBe(false);
    expect(isJvTesting("Device check", "J-V")).toBe(true);
  });
  it("never expands full experiment access even for creators, assignees, members or an accidentally elevated role", () => {
    for (const role of ["ADMIN", "MANAGER", "TECHNICIAN"] as const) {
      const actor = { uid: "tester", org: "org", role, testingOnly: true };
      const resource = {
        organizationId: "org",
        createdById: "tester",
        assigneeId: "tester",
        members: [{ userId: "tester" }],
      };
      for (const permission of [
        canReadExperiment,
        canManageExperiment,
        canCaptureExperiment,
        canSubmitExperiment,
      ])
        expect(permission(actor, resource)).toBe(false);
      expect(() => assertAdmin(actor)).toThrow();
      expect(() => experimentListScope(actor)).toThrow();
      expect(() => measurementVisibilityScope(actor)).toThrow();
    }
  });
  it("requires selected substrates, an image, a run and an idempotency key", () => {
    const input = {
      characterizationId: "char",
      runId: "run",
      sampleIds: ["sample"],
      photoPath: "own/photo.png",
      requestKey: crypto.randomUUID(),
    };
    expect(testingRequestSchema.safeParse(input).success).toBe(true);
    expect(
      testingRequestSchema.safeParse({ ...input, sampleIds: [] }).success,
    ).toBe(false);
    expect(
      testingRequestSchema.safeParse({ ...input, photoPath: "" }).success,
    ).toBe(false);
    expect(
      testingRequestSchema.safeParse({ ...input, requestKey: "bad" }).success,
    ).toBe(false);
  });
});
