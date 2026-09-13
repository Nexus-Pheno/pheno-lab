import type { TestPlan } from "@/lib/library";
import { isScientificSample } from "@/lib/results";
import {
  METRICS,
  metricKeyOf,
  numish,
} from "@/modules/experiments/summary-service";
import type { MetricKey } from "@/modules/experiments/summary-service";

// The tidy dataset: one row per sample, carrying every condition that was
// varied and every metric that was measured (使用反馈报告-2, 2026-09).
//
// This is the shape the technicians build by hand in a spreadsheet before they
// can ask a question — "which of these conditions actually moved PCE". Two
// rules make it answerable ACROSS experiments, which the per-experiment data
// page cannot do:
//
//   1. A condition is keyed by (process, parameter), not by step position. Two
//      experiments that varied anneal temperature at different points in their
//      flow land in the same column.
//   2. Inside one experiment, a condition is what the test plan varied.
//      Across experiments, a condition is whatever differs between their
//      recipes — the material on a step, a parameter held at one value in
//      this batch and another in the next. Only 9 of 959 experiments record
//      a test plan, but 622 record which material went on which step, so
//      the recipe is where cross-experiment conditions actually live
//      (0909批次改善使用反馈 §二). Recipe conditions are constant within an
//      experiment, which is exactly why the per-batch view must be read
//      alongside the pooled one: pooling recipes mixes every other thing
//      that differed between those batches.

export type VariedCondition = {
  /** Stable across experiments: processId + parameter name, lowercased. */
  key: string;
  label: string;
  unit: string;
  process: string;
  /** Group label → value, for the plan/report comparison table. */
  byGroup: Record<string, string>;
  /** "varied" inside the experiment, or a "recipe" constant of it. */
  source: "varied" | "recipe";
};

export type TidyRow = {
  experimentId: string;
  experimentCode: string;
  experimentTitle: string;
  projectName: string | null;
  createdBy: string;
  /** Beijing calendar date the experiment was created — for time trends. */
  date: string;
  sampleId: string;
  sampleCode: string;
  group: string | null;
  isControl: boolean;
  /** Condition key → value, for the conditions this experiment varied. */
  conditions: Record<string, string>;
  metrics: Partial<Record<MetricKey, number>>;
};

type PlanCarrier = { metadata: unknown };

export function testPlanOf(exp: PlanCarrier): TestPlan | undefined {
  return (exp.metadata as { testPlan?: TestPlan } | null)?.testPlan;
}

const conditionKey = (processId: string, parameter: string) =>
  `${processId}::${parameter.trim().toLowerCase()}`;

export type VariableSource = {
  metadata: unknown;
  steps: {
    name: string;
    process: { id: string; name: string };
    parameters: {
      name: string;
      unit: string;
      value: string;
      variations: { variationGroup: string; value: string }[];
    }[];
  }[];
};

/**
 * What this experiment actually varied — the union of the test-plan grid and
 * the variations wired onto the steps themselves.
 *
 * The two disagree more often than they should. A technician who sets a
 * per-group value directly on a step (the 三种添加剂协同 case in cell-17) never
 * appears in `metadata.testPlan`, and the report's comparison table, guarded on
 * the plan alone, came out empty for exactly the experiment it mattered for.
 * Reading both sources means the key variable is captured however it was
 * entered, and the plan stays authoritative for wording and units.
 */
export function variedConditions(exp: VariableSource): VariedCondition[] {
  const plan = testPlanOf(exp);
  const out = new Map<string, VariedCondition>();

  for (const variable of plan?.variables ?? []) {
    const key = conditionKey(variable.processId, variable.parameter);
    const process =
      exp.steps.find((step) => step.process.id === variable.processId)?.process
        .name ?? "";
    out.set(key, {
      key,
      label: variable.parameter,
      unit: variable.unit,
      process,
      byGroup: { ...variable.values },
      source: "varied",
    });
  }

  for (const step of exp.steps) {
    for (const parameter of step.parameters) {
      if (parameter.variations.length === 0) continue;
      const key = conditionKey(step.process.id, parameter.name);
      const byGroup = Object.fromEntries(
        parameter.variations.map((v) => [v.variationGroup, v.value]),
      );
      const known = out.get(key);
      if (known) {
        // The plan named it; the steps carry the values actually applied.
        known.byGroup = { ...byGroup, ...known.byGroup };
        if (!known.process) known.process = step.process.name;
        continue;
      }
      out.set(key, {
        key,
        label: parameter.name,
        unit: parameter.unit,
        process: step.process.name,
        byGroup,
        source: "varied",
      });
    }
  }

  return [...out.values()].sort((a, b) =>
    `${a.process}${a.label}`.localeCompare(`${b.process}${b.label}`),
  );
}

export type RecipeSource = VariableSource & {
  steps: {
    materials?: { material: { name: string } }[];
  }[];
};

export const MATERIAL_SLOT = "material";

/**
 * The recipe an experiment held constant: each step's materials, and each
 * parameter set to one value for every sample. Keyed like varied conditions
 * so the same thing lines up across experiments whichever way it was
 * recorded. Value is the same for every sample of the experiment.
 */
export type RecipeCondition = Omit<VariedCondition, "byGroup"> & {
  value: string;
};

export function recipeConditions(exp: RecipeSource): RecipeCondition[] {
  const out = new Map<string, RecipeCondition>();
  for (const step of exp.steps) {
    const materials = (step.materials ?? [])
      .map((m) => m.material.name.trim())
      .filter(Boolean)
      .sort();
    if (materials.length > 0) {
      const key = conditionKey(step.process.id, MATERIAL_SLOT);
      const known = out.get(key);
      // Two steps of the same process: the recipe is their union.
      const merged = known
        ? [...new Set([...known.value.split(" + "), ...materials])].sort()
        : materials;
      out.set(key, {
        key,
        label: "Material",
        unit: "",
        process: step.process.name,
        source: "recipe",
        value: merged.join(" + "),
      });
    }
    for (const parameter of step.parameters) {
      if (parameter.variations.length > 0) continue;
      const value = parameter.value.trim();
      if (!value) continue;
      const key = conditionKey(step.process.id, parameter.name);
      if (out.has(key)) continue;
      out.set(key, {
        key,
        label: parameter.name,
        unit: parameter.unit,
        process: step.process.name,
        source: "recipe",
        value,
      });
    }
  }
  return [...out.values()];
}

export type DatasetExperiment = RecipeSource & {
  id: string;
  code: string;
  title: string;
  createdAt: Date;
  createdBy: { name: string };
  project: { name: string } | null;
  samples: {
    id: string;
    code: string;
    variationGroup: string | null;
    results: { metrics: unknown }[];
  }[];
};

/** Merge every characterization result a sample carries into one metric set. */
function metricsOf(sample: DatasetExperiment["samples"][number]) {
  const metrics: Partial<Record<MetricKey, number>> = {};
  for (const result of sample.results) {
    const raw = (result.metrics ?? {}) as Record<string, unknown>;
    for (const [label, value] of Object.entries(raw)) {
      const key = metricKeyOf(label);
      if (!key || metrics[key] !== undefined) continue;
      const n = numish(value);
      if (n !== null) metrics[key] = n;
    }
  }
  return metrics;
}

export function buildTidyRows(
  experiments: DatasetExperiment[],
  opts: { recipe?: boolean } = {},
): TidyRow[] {
  const rows: TidyRow[] = [];
  for (const exp of experiments) {
    const plan = testPlanOf(exp);
    const controlGroup = plan?.groups.find((g) => g.isControl)?.label ?? null;
    const conditions = variedConditions(exp);
    const varied = new Set(conditions.map((c) => c.key));
    const recipe = opts.recipe
      ? recipeConditions(exp).filter((c) => !varied.has(c.key))
      : [];
    // Beijing calendar date: the lab's own day, so trends line up with batches.
    const date = new Date(exp.createdAt.getTime() + 8 * 3_600_000)
      .toISOString()
      .slice(0, 10);

    for (const sample of exp.samples) {
      // Scrapped (ERROR) and spare (EXTRA) chips are not experimental groups;
      // pooling them would quietly poison every comparison downstream.
      if (!isScientificSample(sample)) continue;
      const metrics = metricsOf(sample);
      const applied: Record<string, string> = {};
      for (const condition of recipe) applied[condition.key] = condition.value;
      for (const condition of conditions) {
        const value = sample.variationGroup
          ? condition.byGroup[sample.variationGroup]
          : undefined;
        if (value !== undefined && value !== "") applied[condition.key] = value;
      }
      rows.push({
        experimentId: exp.id,
        experimentCode: exp.code,
        experimentTitle: exp.title,
        projectName: exp.project?.name ?? null,
        createdBy: exp.createdBy.name,
        date,
        sampleId: sample.id,
        sampleCode: `${exp.code}-${sample.code}`,
        group: sample.variationGroup,
        isControl: Boolean(
          sample.variationGroup && sample.variationGroup === controlGroup,
        ),
        conditions: applied,
        metrics,
      });
    }
  }
  return rows;
}

export const hasAnyMetric = (row: TidyRow) =>
  METRICS.some((metric) => row.metrics[metric] !== undefined);
