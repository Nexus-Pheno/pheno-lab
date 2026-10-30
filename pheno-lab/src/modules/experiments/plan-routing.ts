import type { TestPlanVariable } from "@/lib/library";

export type TestPlanApplyError = "ambiguous" | "duplicate" | "failed";

export class TestPlanStepError extends Error {
  constructor(readonly code: "ambiguous" | "duplicate") {
    super(`Test plan step routing: ${code}`);
  }
}

type StepIdentity = {
  id: string;
  processId: string;
  equipmentId: string | null;
  layer: string;
};

/** Supplied scope fields are constraints, never hints to overwrite another step. */
export function findTestPlanStep<T extends StepIdentity>(
  variable: Pick<TestPlanVariable, "processId" | "equipmentId" | "layer">,
  steps: T[],
): T | null {
  const candidates = steps.filter(
    (step) => step.processId === variable.processId,
  );
  const exact = candidates.filter(
    (step) =>
      (!variable.equipmentId || step.equipmentId === variable.equipmentId) &&
      (!variable.layer || step.layer === variable.layer),
  );
  if (exact.length > 1) throw new TestPlanStepError("ambiguous");
  if (exact.length === 1) return exact[0];

  // An otherwise compatible step may still have an unassigned machine/layer.
  // Fill only those blanks; a configured conflicting scope must remain intact.
  const unassigned = candidates.filter(
    (step) =>
      (!variable.equipmentId ||
        !step.equipmentId ||
        step.equipmentId === variable.equipmentId) &&
      (!variable.layer || !step.layer || step.layer === variable.layer),
  );
  if (unassigned.length > 1) throw new TestPlanStepError("ambiguous");
  return unassigned[0] ?? null;
}

export const planParameterKey = (stepId: string, name: string) =>
  JSON.stringify([stepId, name.trim().toLowerCase()]);
