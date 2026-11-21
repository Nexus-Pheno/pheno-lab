import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { expect, it, vi } from "vitest";
import { checkGoalEvidence } from "../scripts/weekly-report-model-attainment";
import {
  applyProjectPatch,
  draftCheckpoint,
  checkBindings,
  projectEvidence,
} from "../scripts/weekly-report-model-projects";
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

it("requires the recorded question and actual linked measurement for an answered purpose", () => {
  const project = projectEvidence(
    {
      projectAlias: "p",
      projectName: "Purpose",
      assigned: true,
      experiments: [exp("A")],
      ledgerEntries: [],
      periodPerformance: {
        routeCohorts: [route("A", "CURRENT_PERIOD", "a", 20)],
      },
    },
    base,
    new Map(),
    new Set(),
  );
  const bi = { en: "Compare matched groups.", zh: "比较匹配对照。" };
  const packet = {
    cases: [
      {
        key: "C1",
        source: project.routeCases[0],
        reviewedPurpose: bi,
        reviewedAttainment: bi,
        comparisons: [
          {
            key: "V1",
            routeId: "period-route-" + "a".repeat(24),
            sourcePeriod: "CURRENT_PERIOD" as const,
            eligibleLinkedScans: 1,
          },
        ],
      },
    ],
  };
  const answer = {
    key: "C1",
    status: "PARTIAL" as const,
    goalBasis: "REVIEWER_INTERPRETATION_OF_CURRENT_FIELDS" as const,
    evidenceKeys: ["V1"],
    reason: bi,
  };
  expect(() => checkGoalEvidence(packet, { cases: [answer] })).not.toThrow();
  expect(() =>
    checkGoalEvidence(packet, { cases: [{ ...answer, evidenceKeys: [] }] }),
  ).toThrow("lacks source-linked");
  expect(() =>
    checkGoalEvidence(packet, { cases: [{ ...answer, evidenceKeys: ["V2"] }] }),
  ).toThrow("not in the actual experiment");
  const noGoal = {
    cases: [
      {
        ...packet.cases[0],
        source: { ...packet.cases[0].source, problem: "", hypothesis: "" },
      },
    ],
  };
  expect(() => checkGoalEvidence(noGoal, { cases: [answer] })).toThrow(
    "No recorded intent",
  );
});

it("removes incidental contacts, staff identifiers and links from private project notes", () => {
  const src = {
    ...exp("A"),
    observation:
      "Pressure varied. Reach test@example.test; 13900000000; https://example.test/private; cabcdefghijklmnopqrstuvwxyz",
  };
  const output = projectEvidence(
    {
      projectAlias: "p",
      projectName: "test",
      assigned: true,
      experiments: [src],
      ledgerEntries: [],
      periodPerformance: {
        routeCohorts: [route("A", "CURRENT_PERIOD", "a", 1)],
      },
    },
    base,
    new Map(),
    new Set(),
  );
  expect(output.routeCases[0].observation).toContain("Pressure varied.");
  expect(output.routeCases[0].observation).not.toMatch(
    /@|13900000000|https|cabcdefghijkl/,
  );
});

it("applies a bounded scientific correction without altering source metadata or unaffected fields", () => {
  const bi = { en: "Read the control.", zh: "查看对照。" };
  const row = {
    project: "P1",
    purpose: bi,
    decision: bi,
    priorIssues: bi,
    next: bi,
    confidence: bi,
    routeDisposition: "ADJUST" as const,
    confidenceLevel: "LOW" as const,
    issueAssessments: [],
    routeIntents: [],
  };
  const replacement = {
    en: "First establish a matched control.",
    zh: "先设置匹配对照。",
  };
  const patch = {
    overview: [{ field: "next" as const, value: replacement }],
    intents: [],
    issues: [],
  };
  const updated = applyProjectPatch(row, patch);
  expect(updated).toEqual({ ...row, next: replacement });
  expect(row.next).toEqual(bi);
  expect(() =>
    applyProjectPatch(row, {
      ...patch,
      overview: [patch.overview[0], patch.overview[0]],
    }),
  ).toThrow("Duplicate");
  expect(() => applyProjectPatch(row, { ...patch, overview: [] })).toThrow(
    "failed to change",
  );
  expect(() =>
    applyProjectPatch(row, {
      ...patch,
      intents: [{ experimentCode: "other", field: "next", value: bi }],
    }),
  ).toThrow("different experiment");
});
it("only binds direct tests to experiments with newly measured evidence", () => {
  const e = projectEvidence(
    {
      projectAlias: "p",
      projectName: "Synthetic",
      assigned: true,
      experiments: [exp("A")],
      ledgerEntries: [
        {
          entryId: "prior",
          statement: "Repeat",
          status: "proposed",
          history: [],
        },
      ],
      periodPerformance: {
        routeCohorts: [route("A", "CURRENT_PERIOD", "a", 20)],
      },
    },
    { ...base, freshMeasuredScans: 0 },
    new Map(),
    new Set(),
    new Map([["A", 0]]),
  );
  const bi = { en: "Test the control.", zh: "测试对照。" };
  const source = e.routeCases[0];
  const row = {
    project: e.project,
    purpose: bi,
    decision: bi,
    priorIssues: bi,
    next: bi,
    confidence: bi,
    routeDisposition: "ADJUST" as const,
    confidenceLevel: "LOW" as const,
    issueAssessments: [
      {
        key: "L1",
        assessment: "direct-test" as const,
        testedExperimentCodes: ["A"],
        rationale: bi,
      },
    ],
    routeIntents: [
      {
        experimentCode: source.experimentCode,
        sourceHash: source.sourceHash,
        hashBasis: source.hashBasis,
        representativeRouteId: source.representativeRouteId,
        sourcePeriod: source.sourcePeriod,
        observation: bi,
        problem: bi,
        hypothesis: bi,
        purpose: bi,
        attainment: bi,
        comparison: bi,
        next: bi,
      },
    ],
  };
  expect(e.freshMeasuredScans).toBe(0);
  expect(() => checkBindings(e, row)).toThrow("current direct test");
  expect(() =>
    checkBindings(
      {
        ...e,
        freshMeasuredScans: 1,
        routeCases: [{ ...source, freshMeasuredSources: 1 }],
      },
      row,
    ),
  ).not.toThrow();
});

it("replays every project correction against the original actual rejected independent review", async () => {
  const { verifyProjectAuthorship, replayProjectEdit } =
    await import("../scripts/weekly-report-model-project-edits.mjs");
  const { hashWeeklyReportValue: hash } =
    await import("../scripts/weekly-report-model");
  const evidence = { project: "P1" },
    old = { project: "P1", next: { en: "Existing reference", zh: "已有参照" } };
  const critique = {
    decision: "REVISE",
    findings: [{ severity: "blocking", issue: "Control not verified." }],
  };
  const envelope = (
    role: string,
    id: string,
    input: unknown,
    value: unknown,
  ) => ({
    role,
    completionId: id,
    inputHash: hash(input),
    value,
    outputHash: hash(value),
    evidenceHash: hash(evidence),
  });
  const before = {
    author: envelope("project-author", "original", { evidence }, old),
    reviewer: envelope(
      "project-reviewer",
      "critic",
      { evidence, candidate: old },
      critique,
    ),
  };
  const edit = {
    overview: [
      {
        field: "next",
        value: { en: "Establish a matched control.", zh: "先设置匹配对照。" },
      },
    ],
    intents: [],
    issues: [],
  };
  const value = replayProjectEdit(old, edit);
  const raw = envelope(
    "project-reviser",
    "actual-edit",
    { evidence, revision: { previous: old, review: critique } },
    edit,
  );
  const corrected = {
    patch: { base: old, provider: raw },
    author: {
      ...raw,
      value,
      authorship: "APPLIED_TARGETED_MODEL_EDIT",
      priorDraftHash: hash(old),
      outputHash: hash(value),
      providerOutputHash: raw.outputHash,
    },
  };
  const pool = new Map([
    ["original", { file: "original.json", attempt: before }],
  ]);
  const seal = vi.fn(),
    completion = (
      record: { role: string; value: unknown; outputHash: string },
      role: string,
    ) => {
      expect(record.role).toBe(role);
      expect(record.outputHash).toBe(hash(record.value));
    };
  expect(() =>
    verifyProjectAuthorship(corrected, evidence, pool, {
      hash,
      seal,
      completion,
    }),
  ).not.toThrow();
  expect(seal).toHaveBeenCalledWith("original.json");
  const altered = structuredClone(corrected);
  altered.author.value.next.en = "Altered after review";
  altered.author.outputHash = hash(altered.author.value);
  expect(() =>
    verifyProjectAuthorship(altered, evidence, pool, {
      hash,
      seal,
      completion,
    }),
  ).toThrow();
  const forged = structuredClone(before);
  forged.reviewer.value = { ...critique, decision: "BLOCK", findings: [] };
  expect(() =>
    verifyProjectAuthorship(
      corrected,
      evidence,
      new Map([["original", { file: "original.json", attempt: forged }]]),
      { hash, seal, completion },
    ),
  ).toThrow("original project review");
});

it("resumes the exact completed author stage after a referee interruption and rejects a changed cache", async () => {
  const { hashWeeklyReportValue: hash } =
    await import("../scripts/weekly-report-model");
  const dir = await mkdtemp(join(tmpdir(), "pheno-synthetic-draft-"));
  try {
    const e = projectEvidence(
      {
        projectAlias: "p",
        projectName: "demo",
        assigned: true,
        experiments: [],
        ledgerEntries: [],
        periodPerformance: { routeCohorts: [] },
      },
      base,
      new Map(),
      new Set(),
    );
    const data = { evidence: e },
      val = { summary: "Synthetic fold." },
      role = "project-author" as const;
    const response = {
      role,
      model: "deepseek-v4-pro",
      provider: "deepseek",
      providerHost: "api.deepseek.com",
      requestId: randomUUID(),
      completionId: randomUUID(),
      inputHash: hash(data),
      evidenceHash: hash(e),
      outputHash: hash(val),
      requestHash: hash("test request"),
      promptHash: hash("test prompt"),
      value: val,
    };
    const fetch = vi.fn(async () => response),
      schema = z.object({ summary: z.string() });
    expect(await draftCheckpoint(dir, e, role, schema, data, fetch)).toEqual(
      response,
    );
    expect(await draftCheckpoint(dir, e, role, schema, data, fetch)).toEqual(
      response,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    const p = join(dir, "pending-project-author-P1-" + hash(data) + ".json");
    const altered = JSON.parse(await readFile(p, "utf8"));
    altered.value.summary = "An unpublished changed sentence";
    await writeFile(p, JSON.stringify(altered));
    await expect(
      draftCheckpoint(dir, e, role, schema, data, fetch),
    ).rejects.toThrow("exact pending draft");
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
