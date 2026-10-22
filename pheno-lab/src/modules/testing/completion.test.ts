import { describe, expect, it } from "vitest";
import { testingCompletion } from "./completion";

const samples = [
  { id: "a", variationGroup: "A" },
  { id: "b", variationGroup: "B" },
  { id: "scrap", variationGroup: "ERROR" },
  { id: "spare", variationGroup: null },
  { id: "legacy-spare", variationGroup: "EXTRA" },
];
const requests = [
  { id: "request", runId: "run", characterizationId: "jv", valid: true },
];
const result = (sampleId: string, metrics: unknown = { pce: "0" }) => ({
  sampleId,
  metrics,
  runId: "run",
  characterizationId: "jv",
  source: "MANUAL",
  sourceMeasurementId: null,
});

describe("testing completion", () => {
  it("requires every allocated substrate, excluding ERROR and unassigned spares", () => {
    expect(
      testingCompletion({
        samples,
        requests,
        results: [result("a")],
        measurements: [],
      }).complete,
    ).toBe(false);
    expect(
      testingCompletion({
        samples,
        requests,
        results: [result("a"), result("b")],
        measurements: [],
      }).complete,
    ).toBe(true);
  });
  it("does not call an empty scope or an unsent request complete", () => {
    expect(
      testingCompletion({
        samples: samples.slice(2),
        requests,
        results: [],
        measurements: [],
      }).complete,
    ).toBe(false);
    expect(
      testingCompletion({
        samples,
        requests: [],
        results: [result("a"), result("b")],
        measurements: [],
      }).complete,
    ).toBe(false);
  });
  it("keeps run, characterization and cancelled/invalid request scopes separate", () => {
    for (const wrong of [
      { ...result("b"), runId: "old-run" },
      { ...result("b"), characterizationId: "other" },
    ]) {
      expect(
        testingCompletion({
          samples,
          requests,
          results: [result("a"), wrong],
          measurements: [],
        }).complete,
      ).toBe(false);
    }
    expect(
      testingCompletion({
        samples,
        requests: [{ ...requests[0], valid: false }],
        results: [result("a"), result("b")],
        measurements: [],
      }).complete,
    ).toBe(false);
  });
  it("rejects empty placeholders while preserving legitimate zero results", () => {
    for (const metrics of [
      {},
      { pce: "   " },
      { pce: null },
      { pce: false },
      { pce: {} },
      { pce: Number.NaN },
    ]) {
      expect(
        testingCompletion({
          samples,
          requests,
          results: [result("a"), result("b", metrics)],
          measurements: [],
        }).complete,
      ).toBe(false);
    }
    expect(
      testingCompletion({
        samples,
        requests,
        results: [result("a", { pce: 0 }), result("b")],
        measurements: [],
      }).complete,
    ).toBe(true);
  });
  it("does not trust a stale auto-filled row after a scan was ignored or reassigned", () => {
    const results = [
      result("a"),
      { ...result("b"), source: "INSTRUMENT", sourceMeasurementId: "scan" },
    ];
    for (const measurements of [
      [],
      [{ id: "scan", sampleId: "a", runId: "run" }],
      [{ id: "scan", sampleId: "b", runId: "old" }],
      [{ id: "other", sampleId: "b", runId: "run" }],
    ]) {
      expect(
        testingCompletion({ samples, requests, results, measurements })
          .complete,
      ).toBe(false);
    }
    expect(
      testingCompletion({
        samples,
        requests,
        results,
        measurements: [{ id: "scan", sampleId: "b", runId: "run" }],
      }).complete,
    ).toBe(true);
  });
  it("keeps the unified experiment pending while another submitted run is incomplete", () => {
    const state = testingCompletion({
      samples,
      requests: [
        ...requests,
        { ...requests[0], id: "next", runId: "next-run" },
      ],
      results: [result("a"), result("b")],
      measurements: [],
    });
    expect(state).toEqual({
      complete: false,
      requests: { request: true, next: false },
    });
  });
});
