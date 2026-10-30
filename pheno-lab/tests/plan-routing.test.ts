import { expect, it } from "vitest";
import {
  findTestPlanStep,
  planParameterKey,
} from "@/modules/experiments/plan-routing";

const steps = [
  { id: "htl", processId: "blade", equipmentId: "one", layer: "HTL" },
  { id: "top", processId: "blade", equipmentId: "one", layer: "TOP" },
  { id: "other", processId: "blade", equipmentId: "two", layer: "TOP" },
];
it("matches the process, machine and layer together in either variable order", () => {
  for (const layer of ["HTL", "TOP"])
    expect(
      findTestPlanStep({ processId: "blade", equipmentId: "one", layer }, steps)
        ?.id,
    ).toBe(layer === "HTL" ? "htl" : "top");
  expect(
    findTestPlanStep(
      { processId: "blade", equipmentId: "two", layer: "TOP" },
      steps,
    )?.id,
  ).toBe("other");
});
it("never falls back to a conflicting machine, layer or process", () => {
  expect(
    findTestPlanStep(
      { processId: "blade", equipmentId: "three", layer: "TOP" },
      steps,
    ),
  ).toBeNull();
  expect(
    findTestPlanStep(
      { processId: "blade", equipmentId: "one", layer: "ETL" },
      steps,
    ),
  ).toBeNull();
  expect(
    findTestPlanStep({ processId: "spin", layer: "HTL" }, steps),
  ).toBeNull();
});
it("prefers an exact scope and otherwise allows only a unique compatible blank", () => {
  const blank = {
    id: "blank",
    processId: "blade",
    equipmentId: null,
    layer: "",
  };
  const target = { processId: "blade", equipmentId: "one", layer: "TOP" };
  expect(findTestPlanStep(target, [blank, ...steps])?.id).toBe("top");
  expect(findTestPlanStep(target, [blank, steps[0]])?.id).toBe("blank");
  expect(findTestPlanStep(target, [{ ...blank, layer: "HTL" }])).toBeNull();
});
it("retains legacy process-only routing only when its destination is unique", () => {
  expect(findTestPlanStep({ processId: "blade" }, [steps[0]])?.id).toBe("htl");
  expect(() =>
    findTestPlanStep({ processId: "blade", equipmentId: "one" }, steps),
  ).toThrow("ambiguous");
  expect(() =>
    findTestPlanStep({ processId: "blade", layer: "TOP" }, steps),
  ).toThrow("ambiguous");
});
it("rejects duplicate exact scopes and multiple compatible blanks", () => {
  const target = { processId: "blade", equipmentId: "one", layer: "TOP" };
  expect(() =>
    findTestPlanStep(target, [steps[1], { ...steps[1], id: "duplicate" }]),
  ).toThrow("ambiguous");
  const blank = { ...steps[1], equipmentId: null };
  expect(() =>
    findTestPlanStep(target, [blank, { ...blank, id: "another" }]),
  ).toThrow("ambiguous");
});
it("identifies parameters within a step rather than collapsing same-named variables across layers", () => {
  expect(planParameterKey("top", " Gap/Speed/V ")).toBe(
    planParameterKey("top", "GAP/SPEED/V"),
  );
  expect(planParameterKey("htl", "GAP/Speed/V")).not.toBe(
    planParameterKey("top", "GAP/Speed/V"),
  );
});
