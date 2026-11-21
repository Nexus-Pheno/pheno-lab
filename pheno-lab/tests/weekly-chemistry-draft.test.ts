import { expect, it } from "vitest";
import { scienceInterpretationSchema } from "../scripts/weekly-manuscript/science-contract";

const chemical = scienceInterpretationSchema.shape.cases.element.shape.chemical;
const unresolved = {
  material: null,
  displayName: "sample treatment",
  status: "IDENTITY_UNRESOLVED",
  consultedDescriptorFields: [],
  consultedMotifFields: [],
  identityBoundary: "There is no verified treatment identity.",
  graphHypotheses: [],
  compatibility: [],
  carrierContext: "No actual carrier is recorded.",
  recipes: [],
  limitations: ["Unverified material"],
  controls: ["Matched reference"],
  criteria: ["Compare independent devices"],
  alternatives: ["Process variation"],
  sources: ["S1"],
  priority: "Repeat with a matched reference",
};
it("separates unresolved chemical identity from recipe assignment problems", () => {
  expect(chemical.safeParse(unresolved).success).toBe(true);
  expect(
    chemical.safeParse({
      ...unresolved,
      compatibility: ["The recorded recipe differs"],
    }).success,
  ).toBe(false);
  expect(chemical.safeParse({ ...unresolved, sources: ["E2"] }).success).toBe(
    false,
  );
});
it("allows only actual field names in verified graph consultations", () => {
  const known = {
    ...unresolved,
    status: "CURRENT_VERIFIED_GRAPH",
    material: "M1",
    consultedDescriptorFields: ["polarSurfaceArea"],
    consultedMotifFields: ["phosphonicAcid"],
    graphHypotheses: ["Hypothesis for a current registered material only"],
    compatibility: ["Compare contact coverage"],
  };
  expect(chemical.safeParse(known).success).toBe(true);
  expect(
    chemical.safeParse({
      ...known,
      consultedDescriptorFields: ["polar surface area class"],
    }).success,
  ).toBe(false);
});
