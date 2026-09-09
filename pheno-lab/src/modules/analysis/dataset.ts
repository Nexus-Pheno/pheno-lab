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
//   2. A condition is only recorded when the experiment actually varied it.
//      Constants are context, not evidence, and pooling them across batches
//      would invent comparisons nobody ran.

export type VariedCondition = {
  /** Stable across experiments: processId + parameter name, lowercased. */
  key: string;
  label: string;
  unit: string;
  process: string;
  /** Group label → value, for the plan/report comparison table. */
  byGroup: Record<string, string>;
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
      });
    }
  }

  return [...out.values()].sort((a, b) =>
    `${a.process}${a.label}`.localeCompare(`${b.process}${b.label}`),
  );
}

export type DatasetExperiment = VariableSource & {
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

export function buildTidyRows(experiments: DatasetExperiment[]): TidyRow[] {
  const rows: TidyRow[] = [];
  for (const exp of experiments) {
    const plan = testPlanOf(exp);
    const controlGroup = plan?.groups.find((g) => g.isControl)?.label ?? null;
    const conditions = variedConditions(exp);
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
