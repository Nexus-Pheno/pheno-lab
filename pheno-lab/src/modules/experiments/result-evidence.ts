import { createHash } from "node:crypto";
import { z } from "zod";
import { METRICS, metricKeyOf, type MetricKey } from "@/lib/analysis-metrics";
import { isScientificSample, resultGroupLabels } from "@/lib/results";
import { quantile, summarize } from "@/modules/analysis/stats";
import { describeResultConditions, type ResultStep } from "./results-analysis";
import { testPlanSchema } from "./schema";

/** A display/analysis policy, not a new scientific measurement or source edit. */
export const RESULT_EVIDENCE_POLICY = "accepted-device-result-v1";
export const SCREENING_REFERENCE_PCE_POINTS = 0.5;

// Read legacy records without applying today's write-time allocation refinements.
const evidencePlanSchema = z.object({
  groups: z
    .array(
      testPlanSchema.shape.groups.element.extend({
        samples: testPlanSchema.shape.groups.element.shape.samples.optional(),
      }),
    )
    .min(1)
    .max(100),
  variables: testPlanSchema.shape.variables.default([]),
  substrates: testPlanSchema.shape.substrates,
  assignments: testPlanSchema.shape.assignments,
});
type EvidencePlan = z.infer<typeof evidencePlanSchema>;

type Timestamp = Date | string | null;
export type EvidenceSample = {
  id: string;
  code: string;
  variationGroup: string | null;
};
export type EvidenceResult = {
  id: string;
  sampleId: string | null;
  runId?: string | null;
  run?: { status: string; runNo?: number } | null;
  source?: string;
  metricPolicy?: string;
  sourceMeasurementId?: string | null;
  metrics: unknown;
  capturedAt?: Timestamp;
};
type EvidenceExecution = {
  stepId: string;
  sampleId: string;
  runId?: string;
  actuals: unknown;
  capturedAt: Timestamp;
  flagged?: boolean;
  note?: string;
};
type EvidenceScan = {
  id?: string;
  sampleId?: string | null;
  runId?: string | null;
  status?: string;
  condition?: string | null;
  direction?: string | null;
  metrics: unknown;
  settings?: unknown;
  measuredAt?: Timestamp;
  sample?: { id?: string; code: string; variationGroup: string | null } | null;
};
export type ResultEvidenceExperiment = {
  id: string;
  code: string;
  title: string;
  status: string;
  observation?: string | null;
  problem?: string | null;
  hypothesis?: string | null;
  conclusion?: string | null;
  metadata?: unknown;
  samples: EvidenceSample[];
  steps: ResultStep[];
  characterizations: {
    id: string;
    name: string;
    results: EvidenceResult[];
  }[];
  runs?: {
    id: string;
    status: string;
    runNo?: number;
    executions?: EvidenceExecution[];
  }[];
  jvMeasurements?: EvidenceScan[];
  layers?: { code: string; name: string }[];
};

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const timestamp = (value?: Timestamp) => {
  const parsed = value ? new Date(value).getTime() : 0;
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Exact numeric cells only: do not accept "12 invalid" as a measured 12. */
export function evidenceNumber(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function evidenceMetrics(
  value: unknown,
): Partial<Record<MetricKey, number>> {
  const metrics: Partial<Record<MetricKey, number>> = {};
  for (const [label, raw] of Object.entries(object(value))) {
    const key = metricKeyOf(label);
    const n = evidenceNumber(raw);
    if (key && n !== null) metrics[key] = n;
  }
  return metrics;
}

/** Derived inference only; the original accepted row remains visible unchanged. */
export function inferenceResultMetrics(
  value: unknown,
): Partial<Record<MetricKey, number>> {
  const metrics = evidenceMetrics(value);
  if (metrics.pce !== undefined && (metrics.pce < 0 || metrics.pce > 50))
    return {};
  if (
    metrics.pce !== undefined &&
    metrics.pce > 0 &&
    ((metrics.voc !== undefined && metrics.voc <= 0) ||
      (metrics.jsc !== undefined && metrics.jsc <= 0))
  )
    return {};
  const percentFf = Object.keys(object(value)).some(
    (label) => label === "ff" || /^(?:ff|fill).*%/i.test(label),
  );
  if (
    percentFf &&
    metrics.ff !== undefined &&
    (metrics.ff < 0 || metrics.ff > 100)
  )
    return {};
  return metrics;
}

/**
 * One existing accepted result row per device and characterization. Prefer the
 * latest run, then source-linked instrument BEST; never synthesize a vector
 * from different scans, or weight a device by how often it was scanned.
 * The optional run selection is analysis-only and does not modify source rows.
 */
export function selectRepresentativeResults<T extends EvidenceResult>(
  results: T[],
  samples: EvidenceSample[],
  options: { runId?: string | null } = {},
): T[] {
  const sampleIds = new Set(
    samples.filter(isScientificSample).map((sample) => sample.id),
  );
  const candidates = results.filter(
    (result) =>
      result.sampleId &&
      sampleIds.has(result.sampleId) &&
      result.run?.status !== "CANCELLED" &&
      (options.runId === undefined || (result.runId ?? null) === options.runId),
  );
  const sourceRank = (result: T) =>
    result.source === "INSTRUMENT" &&
    result.sourceMeasurementId &&
    result.metricPolicy === "BEST"
      ? 3
      : result.source === "INSTRUMENT" && result.sourceMeasurementId
        ? 2
        : 1;
  const ordered = [...candidates].sort(
    (a, b) =>
      (b.run?.runNo ?? 0) - (a.run?.runNo ?? 0) ||
      sourceRank(b) - sourceRank(a) ||
      timestamp(b.capturedAt) - timestamp(a.capturedAt) ||
      a.id.localeCompare(b.id),
  );
  const selected = new Map<string, T>();
  for (const row of ordered)
    if (!selected.has(row.sampleId!)) selected.set(row.sampleId!, row);
  return [...selected.values()].sort(
    (a, b) =>
      samples.findIndex((sample) => sample.id === a.sampleId) -
      samples.findIndex((sample) => sample.id === b.sampleId),
  );
}

function stable(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stable(item)]),
    );
  return value;
}

export function resultEvidenceSourceHash(
  exp: ResultEvidenceExperiment,
): string {
  const plan = object(exp.metadata).testPlan ?? null;
  const source = {
    policyVersion: RESULT_EVIDENCE_POLICY,
    id: exp.id,
    code: exp.code,
    title: exp.title,
    status: exp.status,
    observation: exp.observation ?? "",
    problem: exp.problem ?? "",
    hypothesis: exp.hypothesis ?? "",
    conclusion: exp.conclusion ?? "",
    plan,
    samples: exp.samples.map((sample) => ({
      id: sample.id,
      code: sample.code,
      variationGroup: sample.variationGroup,
    })),
    steps: exp.steps.map((step) => ({
      id: step.id,
      name: step.name,
      processId: step.processId,
      equipmentId: step.equipmentId,
      layer: step.layer,
      materials: step.materials.map((material) => ({
        name: material.material.name,
        amount: material.amount,
      })),
      parameters: step.parameters.map((parameter) => ({
        id: parameter.id,
        name: parameter.name,
        unit: parameter.unit,
        value: parameter.value,
        source: parameter.source,
        variations: [...parameter.variations].sort((a, b) =>
          a.variationGroup.localeCompare(b.variationGroup),
        ),
      })),
    })),
    results: exp.characterizations.map((c) => ({
      id: c.id,
      name: c.name,
      results: [...c.results]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((row) => ({
          id: row.id,
          sampleId: row.sampleId,
          runId: row.runId ?? null,
          run: row.run
            ? { status: row.run.status, runNo: row.run.runNo }
            : null,
          source: row.source,
          metricPolicy: row.metricPolicy,
          sourceMeasurementId: row.sourceMeasurementId,
          metrics: row.metrics,
          capturedAt: row.capturedAt,
        })),
    })),
    runs: [...(exp.runs ?? [])]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((run) => ({
        id: run.id,
        status: run.status,
        runNo: run.runNo,
        executions: [...(run.executions ?? [])]
          .sort((a, b) =>
            `${a.stepId}:${a.sampleId}`.localeCompare(
              `${b.stepId}:${b.sampleId}`,
            ),
          )
          .map((execution) => ({
            stepId: execution.stepId,
            sampleId: execution.sampleId,
            runId: execution.runId,
            actuals: execution.actuals,
            capturedAt: execution.capturedAt,
            flagged: execution.flagged,
            note: execution.note,
          })),
      })),
    scans: [...(exp.jvMeasurements ?? [])]
      .sort((a, b) => (a.id ?? "").localeCompare(b.id ?? ""))
      .map((scan) => ({
        id: scan.id,
        sampleId: scan.sampleId,
        runId: scan.runId,
        status: scan.status,
        condition: scan.condition,
        direction: scan.direction,
        metrics: scan.metrics,
        settings: scan.settings,
        measuredAt: scan.measuredAt,
      })),
  };
  return createHash("sha256")
    .update(JSON.stringify(stable(source)))
    .digest("hex");
}

const emptyMetrics = () =>
  Object.fromEntries(METRICS.map((key) => [key, null])) as Record<
    MetricKey,
    MetricSummary | null
  >;
export type MetricSummary = Omit<
  NonNullable<ReturnType<typeof summarize>>,
  "sd"
> & { iqr: number; sd: number | null };
export type ScreeningJudgment =
  | "REFERENCE"
  | "PROMISING"
  | "PROMISING_VARIABLE"
  | "PROCESS_VALUE"
  | "NO_OBSERVED_BENEFIT"
  | "NOT_COMPARABLE";
export type GroupEvidence = {
  label: string;
  sampleIds: string[];
  sampleCodes: string[];
  metrics: Record<MetricKey, MetricSummary | null>;
  deltaMean: Partial<Record<MetricKey, number>>;
  deltaBest: Partial<Record<MetricKey, number>>;
  judgment: ScreeningJudgment;
  evidenceConfidence: "EXPLORATORY" | "UNRESOLVED";
};

function summary(values: number[]): MetricSummary | null {
  const result = summarize(values);
  if (!result) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    ...result,
    sd: result.n > 1 ? result.sd : null,
    iqr: quantile(sorted, 0.75) - quantile(sorted, 0.25),
  };
}

function comparisonReference(
  plan: EvidencePlan | undefined,
  conditions: ReturnType<typeof describeResultConditions>,
  groupLabels: string[],
  requested?: string,
) {
  const declaredGroup =
    plan?.groups?.find((group) => group.isControl)?.label ?? null;
  // Only explicitly named top-passivation material variables qualify. A missing
  // concentration/solvent value or an absent graph does not imply "untreated".
  const passivationMaterials = conditions.filter(
    (condition) =>
      /pass|钝化/i.test(
        `${condition.layer} ${condition.process} ${condition.name}`,
      ) &&
      /material|材料|钝化剂/i.test(condition.name) &&
      !/concentrat|dose|dosage|loading|amount|carrier|solvent|浓度|剂量|负载|用量|溶剂|载液/i.test(
        condition.name,
      ),
  );
  const isUntreated = (value: string | undefined) =>
    value !== undefined &&
    /^(?:\/|none|untreated|no passivation|无|未处理|未钝化)$/i.test(
      value.trim(),
    );
  const untreatedGroups = groupLabels.filter((group) =>
    passivationMaterials.some((condition) =>
      isUntreated(condition.values[group]),
    ),
  );
  const declaredTreated =
    declaredGroup &&
    passivationMaterials.some(
      (condition) =>
        condition.values[declaredGroup]?.trim() &&
        !isUntreated(condition.values[declaredGroup]),
    );
  const selectedGroup =
    requested && groupLabels.includes(requested)
      ? requested
      : untreatedGroups.length === 1 && declaredTreated
        ? untreatedGroups[0]
        : declaredGroup && groupLabels.includes(declaredGroup)
          ? declaredGroup
          : null;
  return {
    declaredGroup,
    untreatedGroups,
    selectedGroup,
    basis:
      requested && groupLabels.includes(requested)
        ? ("ANALYSIS_SELECTION" as const)
        : selectedGroup && selectedGroup !== declaredGroup
          ? ("EXPLICIT_UNTREATED_REFERENCE" as const)
          : ("DECLARED_CONTROL" as const),
    warning:
      selectedGroup && selectedGroup !== declaredGroup
        ? ("COMPARATOR_DIFFERS_FROM_PLAN_CONTROL" as const)
        : untreatedGroups.length > 1
          ? ("MULTIPLE_UNTREATED_REFERENCES" as const)
          : null,
  };
}

export function buildExperimentEvidence(
  exp: ResultEvidenceExperiment,
  options: { referenceGroup?: string; characterizationId?: string } = {},
) {
  const rawPlan = object(exp.metadata).testPlan;
  const parsedPlan = evidencePlanSchema.safeParse(rawPlan);
  const plan = parsedPlan.success ? parsedPlan.data : undefined;
  const labels = [
    ...new Set([
      ...resultGroupLabels(plan?.groups, exp.samples),
      ...resultGroupLabels(undefined, exp.samples),
    ]),
  ].sort();
  const recordedContext = `${exp.title} ${plan?.variables.map((variable) => variable.parameter).join(" ") ?? ""}`;
  const evaluationFocus = /substrate|glass|基底|玻璃|UTG|PEN/i.test(
    recordedContext,
  )
    ? {
        kind: "SUBSTRATE_VALIDATION",
        metrics: ["optical", "electrical", "device"],
        requiresNonJvEvidence: true,
      }
    : /passivat|钝化/i.test(recordedContext)
      ? {
          kind: "PASSIVATION_SCREEN",
          metrics: ["pce", "dispersion", "control"],
          requiresNonJvEvidence: false,
        }
      : /\bSAM\b|sam类型|sam浓度|自组装/i.test(recordedContext)
        ? {
            kind: "SAM_VALIDATION",
            metrics: ["pce", "voc", "ff", "dispersion"],
            requiresNonJvEvidence: false,
          }
        : /process|coating|anneal|工艺|涂布|退火/i.test(recordedContext)
          ? {
              kind: "PROCESS_OPTIMIZATION",
              metrics: ["pce", "mean", "dispersion"],
              requiresNonJvEvidence: false,
            }
          : /material|材料|additive|添加剂/i.test(recordedContext)
            ? {
                kind: "MATERIAL_SCREEN",
                metrics: ["pce", "dispersion", "control"],
                requiresNonJvEvidence: false,
              }
            : {
                kind: "GENERAL",
                metrics: ["recorded-purpose"],
                requiresNonJvEvidence: false,
              };
  const baseConditions = describeResultConditions(
    exp.steps,
    plan,
    exp.layers ?? [],
  );
  const reference = comparisonReference(
    plan,
    baseConditions,
    labels,
    options.referenceGroup,
  );
  const executions = (exp.runs ?? [])
    .filter((run) => run.status !== "CANCELLED")
    .flatMap((run) => run.executions ?? []);
  const measurements = exp.jvMeasurements ?? [];
  const conditions = baseConditions.map((condition) => ({
    ...condition,
    actualByGroup: Object.fromEntries(
      labels.map((label) => {
        const samples = exp.samples.filter(
          (sample) => sample.variationGroup === label,
        );
        const records = samples.flatMap((sample) =>
          executions
            .filter(
              (execution) =>
                execution.stepId === condition.stepId &&
                execution.sampleId === sample.id,
            )
            .filter(
              (execution) =>
                Object.prototype.hasOwnProperty.call(
                  object(execution.actuals),
                  condition.parameterName,
                ) &&
                String(
                  object(execution.actuals)[condition.parameterName] ?? "",
                ).trim() !== "",
            )
            .map((execution) => {
              const raw = object(execution.actuals)[condition.parameterName];
              const value =
                typeof raw === "string" || typeof raw === "number"
                  ? String(raw)
                  : "";
              const sampleMeasurements = measurements.filter(
                (scan) =>
                  scan.sampleId === sample.id && scan.runId === execution.runId,
              );
              const latestMeasuredAt = Math.max(
                0,
                ...sampleMeasurements.map((scan) => timestamp(scan.measuredAt)),
              );
              return {
                sampleId: sample.id,
                sampleCode: sample.code,
                runId: execution.runId ?? null,
                value,
                capturedAt:
                  execution.capturedAt instanceof Date
                    ? execution.capturedAt.toISOString()
                    : execution.capturedAt,
                retrospective:
                  latestMeasuredAt > 0 &&
                  timestamp(execution.capturedAt) > latestMeasuredAt,
                flagged: execution.flagged === true,
              };
            }),
        );
        const values = [...new Set(records.map((record) => record.value))];
        return [
          label,
          {
            status:
              records.length === 0
                ? ("NOT_RECORDED" as const)
                : records.some((record) => record.retrospective)
                  ? ("RETROSPECTIVE" as const)
                  : records.some((record) => record.flagged)
                    ? ("FLAGGED" as const)
                    : values.some((value) => value !== condition.values[label])
                      ? ("DEVIATION" as const)
                      : new Set(records.map((record) => record.sampleId)).size <
                          samples.length
                        ? ("PARTIAL" as const)
                        : ("RECORDED_MATCH" as const),
            records,
            values,
            nRecordedSamples: new Set(records.map((record) => record.sampleId))
              .size,
            nPlannedSamples: samples.length,
          },
        ];
      }),
    ),
  }));
  const characterizations = exp.characterizations
    .filter(
      (c) => !options.characterizationId || c.id === options.characterizationId,
    )
    .map((c) => {
      const selectedResults = selectRepresentativeResults(
        c.results,
        exp.samples,
      );
      const groups: GroupEvidence[] = labels.map((label) => {
        const samples = exp.samples.filter(
          (sample) => sample.variationGroup === label,
        );
        const rows = selectedResults.filter((row) =>
          samples.some((sample) => sample.id === row.sampleId),
        );
        const metrics = emptyMetrics();
        for (const key of METRICS)
          metrics[key] = summary(
            rows.flatMap((row) => {
              const value = inferenceResultMetrics(row.metrics)[key];
              return value === undefined ? [] : [value];
            }),
          );
        return {
          label,
          sampleIds: rows.map((row) => row.sampleId!),
          sampleCodes: rows.map(
            (row) =>
              exp.samples.find((sample) => sample.id === row.sampleId)!.code,
          ),
          metrics,
          deltaMean: {},
          deltaBest: {},
          judgment: "NOT_COMPARABLE",
          evidenceConfidence: "UNRESOLVED",
        };
      });
      const referenceMetrics = groups.find(
        (group) => group.label === reference.selectedGroup,
      )?.metrics;
      for (const group of groups) {
        for (const key of METRICS) {
          if (group.metrics[key] && referenceMetrics?.[key]) {
            group.deltaMean[key] =
              group.metrics[key]!.mean - referenceMetrics[key]!.mean;
            group.deltaBest[key] =
              group.metrics[key]!.best - referenceMetrics[key]!.best;
          }
        }
        const pce = group.metrics.pce;
        const ref = referenceMetrics?.pce;
        if (!pce || !ref) continue;
        group.evidenceConfidence = "EXPLORATORY";
        if (group.label === reference.selectedGroup)
          group.judgment = "REFERENCE";
        else if (group.deltaBest.pce! >= SCREENING_REFERENCE_PCE_POINTS) {
          group.judgment =
            pce.n < 3 || pce.mean <= ref.mean || (pce.sd ?? 0) > (ref.sd ?? 0)
              ? "PROMISING_VARIABLE"
              : "PROMISING";
        } else if (
          pce.mean > ref.mean ||
          (pce.n > 1 && ref.n > 1 && (pce.sd ?? 0) < (ref.sd ?? 0))
        ) {
          group.judgment = "PROCESS_VALUE";
        } else group.judgment = "NO_OBSERVED_BENEFIT";
      }
      const selectedScans = selectedResults.flatMap((result) =>
        measurements.filter(
          (scan) =>
            scan.sampleId === result.sampleId &&
            (scan.runId ?? null) === (result.runId ?? null) &&
            scan.status === "MATCHED" &&
            scan.condition === "LIGHT",
        ),
      );
      const validScans = selectedScans.filter((scan) => {
        const pce = inferenceResultMetrics(scan.metrics).pce;
        return pce !== undefined && pce >= 0 && pce <= 50;
      });
      const highest = [...validScans].sort(
        (a, b) =>
          inferenceResultMetrics(b.metrics).pce! -
          inferenceResultMetrics(a.metrics).pce!,
      )[0];
      const sourceScans = selectedResults.flatMap((result) =>
        measurements.filter((scan) => scan.id === result.sourceMeasurementId),
      );
      const protocolKeys = new Set(
        sourceScans.map((scan) =>
          JSON.stringify(
            stable({
              direction: scan.direction,
              condition: scan.condition,
              area: object(scan.metrics).area,
              settings: Object.fromEntries(
                Object.entries(object(scan.settings)).filter(
                  ([key]) => key !== "traceName",
                ),
              ),
            }),
          ),
        ),
      );
      const runIds = [
        ...new Set(selectedResults.map((row) => row.runId ?? null)),
      ];
      const physicalContexts = new Set(
        sourceScans.map((scan) =>
          JSON.stringify(
            stable({
              area: object(scan.metrics).area,
              direction: scan.direction,
              condition: scan.condition,
            }),
          ),
        ),
      );
      if (physicalContexts.size > 1) {
        for (const group of groups)
          if (group.judgment !== "REFERENCE") {
            group.judgment = "NOT_COMPARABLE";
            group.evidenceConfidence = "UNRESOLVED";
          }
      }
      return {
        id: c.id,
        name: c.name,
        selectedResults,
        unassignedResults: selectedResults.filter((row) =>
          exp.samples.some(
            (sample) => sample.id === row.sampleId && !sample.variationGroup,
          ),
        ),
        groups,
        highestScan: highest
          ? {
              measurementId: highest.id ?? null,
              sampleId: highest.sampleId ?? null,
              pce: inferenceResultMetrics(highest.metrics).pce!,
              direction: highest.direction ?? null,
            }
          : null,
        nSelectedDevices: selectedResults.length,
        nInvalidMetricVectors: selectedResults.filter(
          (row) =>
            Object.keys(evidenceMetrics(row.metrics)).length > 0 &&
            Object.keys(inferenceResultMetrics(row.metrics)).length === 0,
        ).length,
        nSourceScans: validScans.length,
        comparabilityWarnings: [
          ...(rawPlan && !parsedPlan.success ? ["INVALID_PLAN_METADATA"] : []),
          ...(selectedResults.some((row) =>
            exp.samples.some(
              (sample) => sample.id === row.sampleId && !sample.variationGroup,
            ),
          )
            ? ["UNASSIGNED_SAMPLES_NOT_GROUPED"]
            : []),
          ...(runIds.length > 1 ? ["MULTIPLE_RECORDED_RUNS"] : []),
          ...(protocolKeys.size > 1 ? ["PROTOCOL_REVIEW_REQUIRED"] : []),
          ...(physicalContexts.size > 1 ? ["AREA_OR_DIRECTION_DIFFERS"] : []),
          ...(selectedResults.some(
            (row) =>
              Object.keys(evidenceMetrics(row.metrics)).length > 0 &&
              Object.keys(inferenceResultMetrics(row.metrics)).length === 0,
          )
            ? ["INVALID_METRIC_VECTOR_EXCLUDED_FROM_INFERENCE"]
            : []),
          ...(sourceScans.length <
          selectedResults.filter((row) => row.source === "INSTRUMENT").length
            ? ["SOURCE_PROTOCOL_NOT_LINKED"]
            : []),
          "INDEPENDENT_BATCHES_NOT_VERIFIED",
        ],
      };
    });
  return {
    schemaVersion: 1 as const,
    policyVersion: RESULT_EVIDENCE_POLICY,
    sourceHash: createHash("sha256")
      .update(
        JSON.stringify({
          source: resultEvidenceSourceHash(exp),
          referenceGroup: reference.selectedGroup,
          characterizationId: options.characterizationId ?? null,
        }),
      )
      .digest("hex"),
    experiment: {
      id: exp.id,
      code: exp.code,
      title: exp.title,
      status: exp.status,
      observation: exp.observation ?? "",
      problem: exp.problem ?? "",
      hypothesis: exp.hypothesis ?? "",
      conclusion: exp.conclusion ?? "",
    },
    reference,
    evaluationFocus: {
      ...evaluationFocus,
      basis: "RECORDED_CONTEXT_KEYWORDS_NOT_A_PRESPECIFIED_GOAL",
    },
    conditions,
    characterizations,
    interim: exp.status === "DRAFT" || exp.status === "IN_LAB",
    screeningReferencePcePoints: SCREENING_REFERENCE_PCE_POINTS,
    criterionStatus: "EXPLORATORY_INTERNAL_REFERENCE_NOT_CONFIRMATION" as const,
  };
}

export type ExperimentEvidence = ReturnType<typeof buildExperimentEvidence>;
