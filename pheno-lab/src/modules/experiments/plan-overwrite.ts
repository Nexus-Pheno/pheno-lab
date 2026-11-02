import type { TestPlanVariable } from "@/lib/library";
import type { PlanParameterValues, TestPlanOverwrite } from "./plan-routing";
import { planParameterKey } from "./plan-routing";

export type PlanStepSnapshot = {
  id: string;
  name: string;
  processId: string;
  equipmentId: string | null;
  layer: string;
  process: { name: string };
  equipment: { name: string } | null;
  parameters: {
    id: string;
    name: string;
    value: string;
    unit: string;
    source: string;
    variations: { variationGroup: string; value: string }[];
  }[];
};

export function previousPlanParameters(
  steps: PlanStepSnapshot[],
  variables: TestPlanVariable[],
  destinations: Set<string>,
) {
  const removals = new Map<
    string,
    {
      step: PlanStepSnapshot;
      parameter: PlanStepSnapshot["parameters"][number];
    }
  >();
  for (const v of variables) {
    for (const step of steps) {
      if (
        step.processId !== v.processId ||
        (v.equipmentId && step.equipmentId !== v.equipmentId) ||
        (v.layer && step.layer !== v.layer)
      )
        continue;
      if (destinations.has(planParameterKey(step.id, v.parameter))) continue;
      const parameter = step.parameters.find(
        (p) =>
          planParameterKey(step.id, p.name) ===
          planParameterKey(step.id, v.parameter),
      );
      if (parameter) removals.set(parameter.id, { step, parameter });
    }
  }
  return [...removals.values()];
}

const values = (
  parameter: PlanStepSnapshot["parameters"][number],
): PlanParameterValues => ({
  value: parameter.value,
  unit: parameter.unit,
  groups: parameter.variations
    .map((v) => ({ group: v.variationGroup, value: v.value }))
    .sort((a, b) => a.group.localeCompare(b.group)),
});

export function testPlanOverwriteChanges(
  steps: PlanStepSnapshot[],
  bindings: { variable: TestPlanVariable; stepId: string }[],
  groups: { label: string }[],
  control: string,
  removals: ReturnType<typeof previousPlanParameters>,
  resolvedSteps: Pick<PlanStepSnapshot, "id" | "equipment" | "layer">[],
): TestPlanOverwrite[] {
  const changes: TestPlanOverwrite[] = [];
  const add = (
    step: PlanStepSnapshot,
    parameter: PlanStepSnapshot["parameters"][number],
    after: PlanParameterValues | null,
  ) => {
    const before = values(parameter);
    if (
      after !== null &&
      !before.value.trim() &&
      !before.groups.some((g) => g.value.trim()) &&
      !(before.unit.trim() && before.unit !== after.unit)
    )
      return;
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    const destination = resolvedSteps.find((s) => s.id === step.id);
    changes.push({
      parameterId: parameter.id,
      stepName: step.name,
      processName: step.process.name,
      equipmentName: destination?.equipment?.name ?? step.equipment?.name ?? "",
      layer: destination?.layer ?? step.layer,
      parameter: parameter.name,
      before,
      after,
    });
  };
  for (const { variable, stepId } of bindings) {
    const step = steps.find((s) => s.id === stepId);
    const parameter = step?.parameters.find(
      (p) =>
        planParameterKey(stepId, p.name) ===
        planParameterKey(stepId, variable.parameter),
    );
    if (!step || !parameter) continue;
    add(step, parameter, {
      value: variable.values[control] ?? parameter.value,
      unit: variable.unit || parameter.unit,
      groups: groups
        .map((g) => ({ group: g.label, value: variable.values[g.label] ?? "" }))
        .sort((a, b) => a.group.localeCompare(b.group)),
    });
  }
  for (const { step, parameter } of removals) {
    add(
      step,
      parameter,
      parameter.source === "material"
        ? null
        : { value: parameter.value, unit: parameter.unit, groups: [] },
    );
  }
  return changes;
}
