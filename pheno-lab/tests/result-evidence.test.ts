import { describe, expect, it } from "vitest";
import {
  buildExperimentEvidence,
  selectRepresentativeResults,
  evidenceNumber,
  inferenceResultMetrics,
  type ResultEvidenceExperiment,
  type EvidenceResult,
} from "@/modules/experiments/result-evidence";

function fixture(): ResultEvidenceExperiment {
  const samples = [
    { id: "s-a1", code: "S1", variationGroup: "A" },
    { id: "s-b1", code: "S2", variationGroup: "B" },
    { id: "s-b2", code: "S3", variationGroup: "B" },
    { id: "s-c1", code: "S4", variationGroup: "C" },
    { id: "s-c2", code: "S5", variationGroup: "C" },
    { id: "s-error", code: "S6", variationGroup: "ERROR" },
  ];
  const results: EvidenceResult[] = samples.map((sample, i) => ({
    id: `r-${sample.id}`,
    sampleId: sample.id,
    runId: "run1",
    run: { status: "ACTIVE", runNo: 1 },
    source: "INSTRUMENT",
    metricPolicy: "BEST",
    sourceMeasurementId: `m-${sample.id}`,
    metrics: {
      "PCE (%)": [20, 20.1, 20.3, 20.2, 21.3, 49][i],
      "Voc (V)": 1.1,
      "FF (%)": 80,
    },
    capturedAt: "2026-01-02T00:00:00Z",
  }));
  return {
    id: "experiment",
    code: "EX-SYNTHETIC",
    title: "Passivation screening",
    status: "IN_LAB",
    observation: "A prior surface treatment needs confirmation.",
    problem: "Compare against untreated devices.",
    hypothesis: "A candidate may improve output.",
    metadata: {
      testPlan: {
        groups: [
          { label: "A", samples: 1, isControl: true },
          { label: "B", samples: 2, isControl: false },
          { label: "C", samples: 2, isControl: false },
        ],
        variables: [],
      },
    },
    samples,
    layers: [{ code: "PASS_TOP", name: "Top passivation" }],
    steps: [
      {
        id: "step1",
        name: "Top passivation",
        processId: "blade",
        process: { name: "Blade coating" },
        equipmentId: null,
        equipment: null,
        layer: "PASS_TOP",
        materials: [],
        parameters: [
          {
            id: "param1",
            name: "Passivation material",
            unit: "",
            source: "process",
            value: "Reference",
            variations: [
              { variationGroup: "A", value: "Reference" },
              { variationGroup: "B", value: "/" },
              { variationGroup: "C", value: "Candidate" },
            ],
          },
        ],
      },
    ],
    characterizations: [{ id: "jv", name: "JV", results }],
    runs: [{ id: "run1", status: "ACTIVE", runNo: 1, executions: [] }],
    jvMeasurements: results.map((r) => ({
      id: r.sourceMeasurementId!,
      sampleId: r.sampleId,
      runId: r.runId,
      status: "MATCHED",
      condition: "LIGHT",
      direction: "REVERSE",
      metrics: {
        pce: (r.metrics as Record<string, number>)["PCE (%)"],
        area: 1,
      },
      settings: { points: 100, traceName: r.id },
      measuredAt: "2026-01-01T00:00:00Z",
    })),
  };
}

function multistepPassivationFixture(): ResultEvidenceExperiment {
  const exp = fixture();
  for (const sample of exp.samples)
    if (sample.variationGroup === "B") sample.variationGroup = "H";
  for (const variation of exp.steps[0].parameters[0].variations)
    if (variation.variationGroup === "B") variation.variationGroup = "H";
  const dormant = structuredClone(exp.steps[0]);
  dormant.id = "step-dormant";
  dormant.name = "Top passivation evaporation";
  dormant.processId = "evaporation";
  dormant.process.name = "Evaporation";
  dormant.parameters[0].id = "param-dormant";
  dormant.parameters[0].variations = ["A", "H", "C"].map((variationGroup) => ({
    variationGroup,
    value: "/",
  }));
  exp.steps.push(dormant);
  exp.metadata = {
    testPlan: {
      groups: [
        { label: "A", samples: 1, isControl: true },
        { label: "H", samples: 2, isControl: false },
        { label: "C", samples: 2, isControl: false },
        { label: "J", samples: 0, isControl: false },
      ],
      variables: [
        {
          kind: "material",
          processId: "future-evaporation",
          layer: "PASS_TOP",
          parameter: "Future passivation material",
          unit: "",
          values: { J: "Synthetic future inorganic treatment" },
        },
      ],
    },
  };
  return exp;
}

describe("shared accepted-device evidence", () => {
  it("keeps one complete accepted vector per physical device, not one per result row", () => {
    const exp = fixture();
    const first = exp.characterizations[0].results[0];
    exp.characterizations[0].results.push({
      ...first,
      id: "manual",
      source: "MANUAL",
      metrics: { "PCE (%)": 40, "Voc (V)": 9 },
    });
    const selected = selectRepresentativeResults(
      exp.characterizations[0].results,
      exp.samples,
    );
    expect(selected).toHaveLength(5);
    expect(selected[0]).toBe(first);
    expect(selected.every((row) => row.sampleId !== "s-error")).toBe(true);
    expect((selected[0].metrics as Record<string, number>)["Voc (V)"]).toBe(
      1.1,
    );
  });

  it("selects the latest noncancelled run instead of a historical record maximum", () => {
    const exp = fixture();
    const r = exp.characterizations[0].results[0];
    const current = {
      ...r,
      id: "new-run",
      runId: "run2",
      run: { status: "ACTIVE", runNo: 2 },
      metrics: { "PCE (%)": 18 },
    };
    const cancelled = {
      ...r,
      id: "cancelled",
      runId: "run3",
      run: { status: "CANCELLED", runNo: 3 },
      metrics: { "PCE (%)": 42 },
    };
    expect(
      selectRepresentativeResults([r, current, cancelled], exp.samples),
    ).toEqual([current]);
    expect(
      selectRepresentativeResults([r, current], exp.samples, { runId: "run1" }),
    ).toEqual([r]);
  });

  it("distinguishes an explicit untreated reference from a treated plan control without edits", () => {
    const exp = fixture();
    const before = structuredClone(exp);
    const e = buildExperimentEvidence(exp);
    expect(e.reference).toMatchObject({
      declaredGroup: "A",
      selectedGroup: "B",
      untreatedGroups: ["B"],
      basis: "EXPLICIT_UNTREATED_REFERENCE",
      warning: "COMPARATOR_DIFFERS_FROM_PLAN_CONTROL",
    });
    expect(
      buildExperimentEvidence(exp, { referenceGroup: "A" }).reference
        .selectedGroup,
    ).toBe("A");
    expect(exp).toEqual(before);
  });

  it("reads legacy control and variable definitions without allocation counts", () => {
    const exp = fixture();
    exp.steps = [];
    exp.metadata = {
      testPlan: {
        groups: [
          { label: "A", isControl: true },
          { label: "B", isControl: false },
          { label: "C", isControl: false },
        ],
        variables: [
          {
            kind: "material",
            processId: "blade",
            layer: "PASS_TOP",
            parameter: "Passivation material",
            unit: "",
            values: { A: "Reference", B: "/", C: "Candidate" },
          },
        ],
      },
    };
    const before = structuredClone(exp);
    const evidence = buildExperimentEvidence(exp);
    expect(evidence.reference).toMatchObject({
      declaredGroup: "A",
      selectedGroup: "B",
      untreatedGroups: ["B"],
      warning: "COMPARATOR_DIFFERS_FROM_PLAN_CONTROL",
    });
    expect(evidence.conditions[0]).toMatchObject({
      plannedOnly: true,
      values: { A: "Reference", B: "/", C: "Candidate" },
    });
    const candidate = evidence.characterizations[0].groups.find(
      (group) => group.label === "C",
    )!;
    expect(candidate.metrics.pce?.n).toBe(2);
    expect(candidate.deltaMean.pce).toBeCloseTo(0.55);
    expect(candidate.deltaBest.pce).toBeCloseTo(1);
    expect(
      buildExperimentEvidence(exp, { referenceGroup: "A" }).reference
        .selectedGroup,
    ).toBe("A");
    expect(exp).toEqual(before);
  });

  it("requires untreated values across all applicable passivation steps, excluding future-only groups", () => {
    const exp = multistepPassivationFixture();
    const before = structuredClone(exp);
    const evidence = buildExperimentEvidence(exp);
    expect(evidence.reference).toMatchObject({
      declaredGroup: "A",
      selectedGroup: "H",
      untreatedGroups: ["H"],
      warning: "COMPARATOR_DIFFERS_FROM_PLAN_CONTROL",
    });
    expect(
      evidence.conditions.find((condition) => condition.plannedOnly)?.values,
    ).toEqual({ J: "Synthetic future inorganic treatment" });
    expect(
      evidence.characterizations[0].groups.find((group) => group.label === "C")
        ?.deltaMean.pce,
    ).toBeCloseTo(0.55);
    expect(exp).toEqual(before);
  });

  it.each(["treated", "missing", "blank"])(
    "does not infer an untreated device when another applicable step is %s",
    (state) => {
      const exp = multistepPassivationFixture();
      const parameter = exp.steps[1].parameters[0];
      if (state === "missing")
        parameter.variations = parameter.variations.filter(
          (variation) => variation.variationGroup !== "H",
        );
      else
        parameter.variations.find(
          (variation) => variation.variationGroup === "H",
        )!.value = state === "blank" ? "" : "Synthetic second treatment";
      expect(buildExperimentEvidence(exp).reference).toMatchObject({
        declaredGroup: "A",
        selectedGroup: "A",
        untreatedGroups: [],
      });
    },
  );

  it("does not infer untreated from missing dose or from two ambiguous untreated groups", () => {
    const exp = fixture();
    exp.steps[0].parameters[0].name = "Concentration";
    expect(buildExperimentEvidence(exp).reference.selectedGroup).toBe("A");
    exp.steps[0].parameters[0].name = "Passivation material";
    exp.steps[0].parameters[0].variations[2].value = "untreated";
    expect(buildExperimentEvidence(exp).reference).toMatchObject({
      selectedGroup: "A",
      warning: "MULTIPLE_UNTREATED_REFERENCES",
    });
  });

  it.each([
    "钝化剂浓度",
    "钝化材料载液",
    "Passivation material concentration",
    "Passivation material solvent",
  ])("does not infer an untreated reference from a slash in %s", (name) => {
    const exp = fixture();
    exp.steps[0].parameters[0].name = name;
    const result = buildExperimentEvidence(exp);
    expect(result.reference.selectedGroup).toBe("A");
    expect(result.reference.untreatedGroups).toEqual([]);
    expect(result.reference.basis).toBe("DECLARED_CONTROL");
  });

  it("retains a high champion as promising while separating variation and confidence", () => {
    const char = buildExperimentEvidence(fixture()).characterizations[0];
    const c = char.groups.find((g) => g.label === "C")!;
    expect(c.metrics.pce).toMatchObject({
      n: 2,
      mean: 20.75,
      best: 21.3,
      worst: 20.2,
    });
    expect(c.deltaBest.pce).toBeCloseTo(1);
    expect(c.judgment).toBe("PROMISING_VARIABLE");
    expect(c.evidenceConfidence).toBe("EXPLORATORY");
    expect(char.nSelectedDevices).toBe(5);
  });

  it("retains useful mean or dispersion improvement below the champion heuristic", () => {
    const exp = fixture();
    for (const row of exp.characterizations[0].results)
      if (row.sampleId?.startsWith("s-c")) row.metrics = { "PCE (%)": 20.35 };
    const c = buildExperimentEvidence(exp).characterizations[0].groups.find(
      (g) => g.label === "C",
    )!;
    expect(c.deltaBest.pce!).toBeLessThan(0.5);
    expect(c.judgment).toBe("PROCESS_VALUE");
  });

  it("uses each component's own denominator and leaves n=1 SD unknown", () => {
    const exp = fixture();
    const row = exp.characterizations[0].results.find(
      (r) => r.sampleId === "s-c2",
    )!;
    row.metrics = { "PCE (%)": 21.3 };
    const c = buildExperimentEvidence(exp).characterizations[0].groups.find(
      (g) => g.label === "C",
    )!;
    expect(c.metrics.pce?.n).toBe(2);
    expect(c.metrics.voc?.n).toBe(1);
    expect(c.metrics.voc?.sd).toBeNull();
    expect(evidenceNumber("12 invalid")).toBeNull();
    expect(evidenceNumber(" ")).toBeNull();
    expect(evidenceNumber("0")).toBe(0);
  });

  it("does not equate absent actual captures with agreement to the plan", () => {
    expect(
      buildExperimentEvidence(fixture()).conditions[0].actualByGroup.C.status,
    ).toBe("NOT_RECORDED");
  });

  it("marks recorded-after-measurement conditions as retrospective", () => {
    const exp = fixture();
    exp.runs![0].executions = [
      {
        stepId: "step1",
        sampleId: "s-c1",
        runId: "run1",
        actuals: { "Passivation material": "Candidate" },
        capturedAt: "2026-01-03T00:00:00Z",
      },
    ];
    const actual = buildExperimentEvidence(exp).conditions[0].actualByGroup.C;
    expect(actual.status).toBe("RETROSPECTIVE");
    expect(actual.records[0].retrospective).toBe(true);
    exp.runs![0].executions![0].capturedAt = "2025-12-31T00:00:00Z";
    expect(
      buildExperimentEvidence(exp).conditions[0].actualByGroup.C.status,
    ).toBe("PARTIAL");
    exp.runs![0].executions!.push({
      ...exp.runs![0].executions![0],
      sampleId: "s-c2",
    });
    expect(
      buildExperimentEvidence(exp).conditions[0].actualByGroup.C.status,
    ).toBe("RECORDED_MATCH");
  });

  it("changes the hash for child measurements/captures but not its own generated metadata", () => {
    const exp = fixture();
    const original = buildExperimentEvidence(exp).sourceHash;
    exp.metadata = {
      ...(exp.metadata as object),
      aiSummary: { text: "generated" },
      aiSummaryRun: { state: "done" },
    };
    expect(buildExperimentEvidence(exp).sourceHash).toBe(original);
    exp.characterizations[0].results[0].metrics = { "PCE (%)": 19 };
    expect(buildExperimentEvidence(exp).sourceHash).not.toBe(original);
    expect(
      buildExperimentEvidence(fixture(), { referenceGroup: "A" }).sourceHash,
    ).not.toBe(original);
    const capture = fixture();
    capture.runs![0].executions = [
      {
        stepId: "step1",
        sampleId: "s-c1",
        actuals: { "Passivation material": "Candidate" },
        capturedAt: "2025-12-31T00:00:00Z",
      },
    ];
    expect(buildExperimentEvidence(capture).sourceHash).not.toBe(original);
  });

  it("keeps fingerprints stable when unordered source rows change enumeration order", () => {
    const exp = fixture();
    const original = buildExperimentEvidence(exp).sourceHash;
    exp.characterizations[0].results.reverse();
    exp.jvMeasurements!.reverse();
    expect(buildExperimentEvidence(exp).sourceHash).toBe(original);
  });

  it("reports raw scan maxima separately and never promotes scan counts into device counts", () => {
    const exp = fixture();
    exp.jvMeasurements!.push({
      ...exp.jvMeasurements![3],
      id: "repeat",
      metrics: { pce: 21.8, area: 1 },
    });
    const c = buildExperimentEvidence(exp).characterizations[0];
    expect(c.highestScan?.pce).toBe(21.8);
    expect(c.nSourceScans).toBe(6);
    expect(c.nSelectedDevices).toBe(5);
    expect(c.groups.find((g) => g.label === "C")?.metrics.pce?.best).toBe(21.3);
  });

  it("surfaces physical protocol differences while preserving exploratory output", () => {
    const exp = fixture();
    exp.jvMeasurements![3].metrics = { pce: 20.2, area: 2 };
    const c = buildExperimentEvidence(exp).characterizations[0];
    expect(c.comparabilityWarnings).toContain("PROTOCOL_REVIEW_REQUIRED");
    expect(c.groups.find((g) => g.label === "C")?.evidenceConfidence).toBe(
      "UNRESOLVED",
    );
    expect(c.groups.find((g) => g.label === "C")?.judgment).toBe(
      "NOT_COMPARABLE",
    );
    expect(
      buildExperimentEvidence(fixture()).characterizations[0]
        .comparabilityWarnings,
    ).not.toContain("PROTOCOL_REVIEW_REQUIRED");
  });

  it("preserves an invalid raw row while excluding its vector from inference", () => {
    const exp = fixture();
    const r = exp.characterizations[0].results[0];
    const raw = { ...r, metrics: { "PCE (%)": 99 } };
    expect(selectRepresentativeResults([raw], exp.samples)).toEqual([raw]);
    exp.characterizations[0].results = [raw];
    const group = buildExperimentEvidence(exp).characterizations[0];
    expect(group.groups.find((g) => g.label === "A")?.metrics.pce).toBeNull();
    expect(group.nInvalidMetricVectors).toBe(1);
    expect(inferenceResultMetrics({ pce: 21, voc: -1 })).toEqual({});
    expect(inferenceResultMetrics({ pce: 21, jsc: 0 })).toEqual({});
    expect(inferenceResultMetrics({ pce: 21, "FF (%)": 101 })).toEqual({});
    expect(inferenceResultMetrics({ "PCE (%)": 21 })).toEqual({ pce: 21 });
    expect(inferenceResultMetrics({ "PCE (%)": 0 })).toEqual({ pce: 0 });
    expect(
      selectRepresentativeResults(
        [{ ...r, run: { status: "CANCELLED" } }],
        exp.samples,
      ),
    ).toEqual([]);
  });
  it("fails softly on malformed legacy plan metadata and retains actual group labels", () => {
    const exp = fixture();
    exp.metadata = { testPlan: { groups: "invalid", variables: 12 } };
    const c = buildExperimentEvidence(exp).characterizations[0];
    expect(c.comparabilityWarnings).toContain("INVALID_PLAN_METADATA");
    expect(c.groups.map((g) => g.label)).toEqual(["A", "B", "C"]);
  });
  it("flags non-JV evidence needed for a substrate purpose rather than inventing optical outcomes", () => {
    const exp = fixture();
    exp.title = "Glass substrate validation";
    const e = buildExperimentEvidence(exp);
    expect(e.evaluationFocus).toMatchObject({
      kind: "SUBSTRATE_VALIDATION",
      requiresNonJvEvidence: true,
    });
    expect(e.evaluationFocus.metrics).toEqual([
      "optical",
      "electrical",
      "device",
    ]);
  });
});
