import { expect, it, vi } from "vitest";
import { projectEvidence } from "../scripts/weekly-report-model-projects";
vi.mock("@/infrastructure/db/client", () => ({ db: {} }));
const base = {
  id: "P1",
  assigned: true,
  measuredScans: 1,
  olderReceipts: 5,
  priorUnseenSources: 6,
};
const route = (
  code: string,
  cohort:
    "CURRENT_PERIOD" | "PREVIOUS_EQUAL_DURATION_PERIOD" | "EARLIER_HISTORY",
  hex: string,
  mean: number,
  nSamples = 3,
) => ({
  view: "STRICT_RECORDED_PROTOCOL",
  routeId: "period-route-" + hex.repeat(24),
  periodCohort: cohort,
  experimentCode: code,
  group: "A",
  direction: "forward",
  comparabilityIssues: [],
  inferenceOutcomes: {
    nSamples,
    metrics: {
      pce: {
        nSamples,
        mean,
        median: mean,
        iqr: null,
        sampleStandardDeviation: null,
      },
    },
  },
  pceExtremes: {
    championValidScan: { pce: mean },
    bestPhysicalSampleMedian: { pce: mean },
  },
});
const exp = (experimentCode: string) => ({
  experimentCode,
  title: "Synthetic route",
  observation: "Matched device",
  problem: "Control variation",
  hypothesis: "Check preparation",
  conclusion: "",
});
it("selects covered project routes by cohort and comparable samples without picking champions", () => {
  const selected = projectEvidence(
    {
      projectAlias: "project-1",
      projectName: "Test",
      assigned: true,
      experiments: ["A", "B", "C", "Z"].map(exp),
      ledgerEntries: [
        {
          entryId: "prior-1",
          status: "proposed",
          statement: "Repeat once",
          history: [{ decisionNote: "Pending." }],
        },
      ],
      periodPerformance: {
        routeCohorts: [
          route("A", "CURRENT_PERIOD", "a", 99),
          route("B", "CURRENT_PERIOD", "b", 20),
          route("B", "PREVIOUS_EQUAL_DURATION_PERIOD", "b", 19),
          route("C", "EARLIER_HISTORY", "c", 18),
          route("Z", "EARLIER_HISTORY", "f", 0, 0),
        ],
      },
    },
    base,
    new Map(),
    new Set(["A"]),
  );
  expect(selected.routeCases.map((r) => r.experimentCode)).toEqual(["B", "C"]);
  expect(selected.scope.eligibleRouteCount).toBe(3);
  expect(selected.scope.experimentCount).toBe(4);
  expect(selected.routeCases[0].routes[0].cohorts.map((c) => c.mean)).toEqual([
    20, 19,
  ]);
  expect(selected.routeCases[0].hashBasis).toBe("dossier-intent-route");
  expect(selected.priorIssues).toEqual([
    {
      key: "L1",
      statement: "Repeat once",
      status: "proposed",
      previousDecision: "Pending.",
    },
  ]);
});
it("keeps empty projects explicit and never manufactures a baseline or measurement", () => {
  const selected = projectEvidence(
    {
      projectAlias: "empty",
      projectName: "Empty",
      assigned: true,
      experiments: [],
      ledgerEntries: [],
      periodPerformance: { routeCohorts: [] },
    },
    { ...base, measuredScans: 0 },
    new Map(),
    new Set(),
  );
  expect(selected.scope.eligibleRouteCount).toBe(0);
  expect(selected.routeCases).toEqual([]);
});
