import type { TestPlan } from "@/lib/library";
import { metricKeyOf } from "@/lib/analysis-metrics";
import { summarize } from "@/modules/analysis/stats";

export type ResultStep = {
  id: string;
  name: string;
  processId: string;
  process: { name: string };
  equipmentId: string | null;
  equipment: { name: string; nickname: string } | null;
  layer: string;
  materials: { material: { name: string }; amount: string }[];
  parameters: {
    id: string;
    name: string;
    unit: string;
    value: string;
    source: string;
    variations: { variationGroup: string; value: string }[];
  }[];
};

/** Keep step identity: repeated processes can build different device layers. */
export function describeResultConditions(
  steps: ResultStep[],
  plan: Pick<TestPlan, "variables"> | undefined,
  layers: { code: string; name: string }[],
) {
  const variables = plan?.variables ?? [];
  const context = (step: ResultStep) => ({
    process: step.name || step.process.name,
    layer:
      layers.find((layer) => layer.code === step.layer)?.name || step.layer,
    equipment: step.equipment?.nickname || step.equipment?.name || "",
    materials: step.materials.map(({ material, amount }) =>
      [material.name, amount].filter(Boolean).join(" "),
    ),
    materialVariables: step.parameters
      .filter((parameter) => parameter.source === "material")
      .map((parameter) => parameter.name),
  });
  const matches = variables.map((variable) =>
    steps.filter(
      (step) =>
        step.processId === variable.processId &&
        (!variable.layer || step.layer === variable.layer) &&
        (!variable.equipmentId || step.equipmentId === variable.equipmentId) &&
        step.parameters.some(
          (parameter) => parameter.name === variable.parameter,
        ),
    ),
  );
  const linked = new Set<number>();
  const conditions = steps.flatMap((step) =>
    step.parameters
      .filter((parameter) => parameter.variations.length > 0)
      .map((parameter) => {
        const planIndex = variables.findIndex(
          (variable, index) =>
            matches[index].length === 1 &&
            matches[index][0].id === step.id &&
            variable.parameter === parameter.name &&
            (variable.kind === "material") ===
              (parameter.source === "material"),
        );
        if (planIndex >= 0) linked.add(planIndex);
        return {
          id: parameter.id,
          stepId: step.id as string | null,
          parameterName: parameter.name,
          name: parameter.name,
          unit: parameter.unit,
          ...context(step),
          values: Object.fromEntries(
            parameter.variations.map((variation) => [
              variation.variationGroup,
              variation.value,
            ]),
          ),
          plannedValues: planIndex >= 0 ? variables[planIndex].values : null,
          plannedOnly: false,
        };
      }),
  );
  variables.forEach((variable, index) => {
    if (linked.has(index)) return;
    const step = matches[index].length === 1 ? matches[index][0] : null;
    conditions.push({
      id: `plan-${index}`,
      stepId: step?.id ?? null,
      parameterName: variable.parameter,
      name: variable.parameter,
      unit: variable.unit,
      ...(step
        ? context(step)
        : {
            process: "",
            layer:
              layers.find((layer) => layer.code === variable.layer)?.name ||
              variable.layer ||
              "",
            equipment: "",
            materials: [],
            materialVariables: [],
          }),
      values: variable.values,
      plannedValues: null,
      plannedOnly: true,
    });
  });
  return conditions;
}

export type ResultCondition = ReturnType<
  typeof describeResultConditions
>[number];

/** Analyze precisely the data already selected for one characterization's plots. */
export function analyzeResultPlots(
  plots: {
    metric: string;
    groups: { label: string; values: { value: number; code: string }[] }[];
  }[],
  controlGroup: string | undefined,
) {
  return plots
    .filter((plot) => metricKeyOf(plot.metric) !== null)
    .map((plot) => {
      const groups = plot.groups.map((group) => ({
        label: group.label,
        summary: summarize(
          group.values.map(({ value }) => value).filter(Number.isFinite),
        ),
      }));
      const control = groups.find((group) => group.label === controlGroup);
      const measured = groups.filter((group) => group.summary !== null);
      const highestMean = Math.max(
        ...measured.map((group) => group.summary!.mean),
      );
      return {
        metric: plot.metric,
        groups: groups.map((group) => ({
          ...group,
          delta:
            group.summary && control?.summary
              ? group.summary.mean - control.summary.mean
              : null,
        })),
        // Retain ties; a high observed mean alone does not establish a winner.
        highest: measured.filter(
          (group) => group.summary!.mean === highestMean,
        ),
      };
    });
}
