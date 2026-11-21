import { describe, expect, it } from "vitest";
import { replayScienceEdit } from "../scripts/weekly-manuscript/replay-science-edit.mjs";
import { scientificEditOutput } from "../scripts/weekly-manuscript/science-edits-contract";

const original = {
  cases: [
    {
      experiment: "E1",
      sourceHash: "f".repeat(64),
      public: {
        result: { en: "Original measured result", zh: "测量结果" },
        judgment: { en: "First judgment", zh: "此前判断" },
        conditions: [
          {
            group: "G1",
            condition: { en: "Reference condition", zh: "对照条件" },
          },
        ],
      },
      chemical: {
        material: "M1",
        sources: ["LINKER"],
        limitations: ["First limitation"],
      },
    },
  ],
  priorities: [{ en: "Repeat the comparison", zh: "重复对照实验" }],
};
const replacement = { en: "Check the fabrication record", zh: "核对制备记录" };

describe("targeted scientific corrections", () => {
  it("replays one bilingual correction without touching other verified fields or the source", () => {
    const edit = scientificEditOutput.parse({
      changes: [{ path: "cases.0.public.judgment", replacement }],
    });
    const corrected = replayScienceEdit(original, edit);
    expect(corrected.cases[0].public.judgment).toEqual(replacement);
    expect(original.cases[0].public.judgment.en).toBe("First judgment");
    expect(corrected.cases[0].public.result).toEqual(
      original.cases[0].public.result,
    );
    expect(replayScienceEdit(original, edit)).toEqual(corrected);
  });
  it.each([
    "cases.0.sourceHash",
    "cases.0.chemical.material",
    "cases.0.chemical.sources.0",
    "cases.0.public.conditions.0.group",
    "cases.1.public.judgment",
    "__proto__.x",
  ])("refuses absent or protected field %s", (path) => {
    expect(() =>
      replayScienceEdit(original, { changes: [{ path, replacement }] }),
    ).toThrow();
  });
  it("rejects half-translated or duplicate edits", () => {
    const path = "cases.0.public.result";
    expect(() =>
      replayScienceEdit(original, {
        changes: [{ path, replacement: "English only" }],
      }),
    ).toThrow();
    expect(() =>
      replayScienceEdit(original, {
        changes: [
          { path, replacement },
          { path, replacement },
        ],
      }),
    ).toThrow();
  });
});

it("recovers the exact interrupted author once, and refuses altered frozen input", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { hashWeeklyReportValue: hash } =
    await import("../scripts/weekly-report-model");
  const { privateScienceInputSchema } =
    await import("../scripts/weekly-manuscript/science-contract");
  const { resumeScientificAuthor } =
    await import("../scripts/weekly-manuscript/saved-science-author");
  const dir = await mkdtemp(join(tmpdir(), "pheno-saved-scientist-test-"));
  try {
    const t = "2026-01-01T00:00:00.000Z";
    const evidence = privateScienceInputSchema.shape.evidence.parse({
      publicEvidence: {
        schemaVersion: 1,
        period: { start: t, end: t, acceptedAsOf: t },
        method: "pheno-device-evidence-2026-10-28",
        papers: [],
        projects: [],
        inventory: [],
        cases: [],
      },
      publicDraft: null,
      followupRecords: [],
      cases: [],
      articles: [],
    });
    const value = {
      cases: [],
      priorities: [{ en: "Check the sample count.", zh: "核对样品数量。" }],
      followupAssessments: [],
    };
    const record = {
      value,
      role: "scientist",
      provider: "deepseek",
      providerHost: "api.deepseek.com",
      model: "deepseek-v4-pro",
      requestId: "test-request",
      completionId: "test-completion",
      evidenceHash: hash(evidence),
      inputHash: hash({ evidence }),
      outputHash: hash(value),
    };
    await writeFile(
      join(dir, "scientist-attempt-1.json"),
      JSON.stringify(record),
    );
    await writeFile(
      join(dir, "scientist-checkpoint-1.json"),
      JSON.stringify({ ...record, checkpointPolicy: "test-policy" }),
    );
    expect(await resumeScientificAuthor(dir, 1, evidence)).toEqual(record);
    await expect(
      resumeScientificAuthor(dir, 1, evidence),
    ).rejects.toMatchObject({ code: "EEXIST" });
    await expect(
      resumeScientificAuthor(dir, 1, {
        ...evidence,
        publicEvidence: {
          ...evidence.publicEvidence,
          period: { ...evidence.publicEvidence.period, carriedForward: true },
        },
      }),
    ).rejects.toThrow(/frozen evidence/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
