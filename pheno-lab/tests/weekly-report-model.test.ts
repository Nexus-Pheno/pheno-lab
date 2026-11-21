import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  callWeeklyReportModel,
  callWeeklyScienceModel,
  callWeeklyFinalReview,
  hashWeeklyReportValue,
} from "../scripts/weekly-report-model";
import {
  authorSystem,
  manuscriptSchema,
  peerReviewSchema,
  reviewerSystem,
} from "../scripts/weekly-manuscript/contract";

// Narrow fixture contracts isolate transport behavior. The manuscript suite
// separately checks the production evidence allowlist and substantive review.
vi.mock("../scripts/weekly-manuscript/contract", async () => {
  const { z } = await import("zod");
  const evidence = z.strictObject({ deviceCount: z.number().int() });
  const manuscript = z.strictObject({ finding: z.string() });
  return {
    authorSystem: "Analyze the evidence",
    reviewerSystem: "Independently challenge the actual draft",
    authorInputSchema: z.strictObject({ evidence }),
    projectionSchema: evidence,
    reviewerInputSchema: z.strictObject({ evidence, draft: manuscript }),
    manuscriptSchema: manuscript,
    peerReviewSchema: z.strictObject({ verdict: z.enum(["accept", "revise"]) }),
  };
});

const mocks = vi.hoisted(() => ({
  org: vi.fn(),
  activeProvider: vi.fn(),
  decrypt: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("@/infrastructure/db/client", () => ({
  db: { organization: { findUniqueOrThrow: mocks.org } },
}));
vi.mock("@/modules/ai/client", () => ({
  activeProvider: mocks.activeProvider,
}));
vi.mock("@/infrastructure/crypto/credential-server", () => ({
  decryptCredential: mocks.decrypt,
}));

const evidence = { deviceCount: 4 };
const draft = { finding: "Repeat the controlled comparison." };
const author = {
  orgId: "test-org",
  role: "author" as const,
  system: authorSystem,
  schema: manuscriptSchema,
  payload: { evidence },
};
const active = {
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-v4-flash",
  apiKey: "synthetic-encrypted",
};

function complete(value: unknown, model = "deepseek-v4-pro", finish = "stop") {
  return Response.json({
    id: crypto.randomUUID(),
    model,
    choices: [
      {
        finish_reason: finish,
        message: {
          role: "assistant",
          content: JSON.stringify(value),
          reasoning_content: "synthetic-private-reasoning",
        },
      },
    ],
  });
}

beforeEach(() => {
  mocks.org.mockResolvedValue({ id: "test-org" });
  mocks.activeProvider.mockResolvedValue(active);
  mocks.decrypt.mockReturnValue("synthetic-plain");
  mocks.fetch.mockReset();
  vi.stubGlobal("fetch", mocks.fetch);
});
afterEach(() => vi.unstubAllGlobals());

describe("weekly scientific author and reviewer transport", () => {
  it("uses two fresh Pro contexts and binds the exact reviewed evidence and draft", async () => {
    mocks.fetch
      .mockResolvedValueOnce(complete(draft))
      .mockResolvedValueOnce(complete({ verdict: "revise" }));
    const written = await callWeeklyReportModel(author);
    const reviewed = await callWeeklyReportModel({
      ...author,
      role: "reviewer",
      system: reviewerSystem,
      payload: { evidence, draft: written.value },
      schema: peerReviewSchema,
    });
    expect(written.value).toEqual(draft);
    expect(reviewed.value).toEqual({ verdict: "revise" });
    expect(reviewed.evidenceHash).toBe(written.evidenceHash);
    expect(written.outputHash).toEqual(hashWeeklyReportValue(draft));
    expect(reviewed.inputHash).toEqual(
      hashWeeklyReportValue({ draft, evidence }),
    );
    expect(reviewed.completionId).not.toBe(written.completionId);
    expect(reviewed.promptHash).not.toBe(written.promptHash);
    expect(reviewed.requestHash).not.toBe(written.requestHash);
    for (const [endpoint, options] of mocks.fetch.mock.calls) {
      expect(endpoint).toBe("https://api.deepseek.com/v1/chat/completions");
      expect(options.redirect).toBe("error");
      const body = JSON.parse(options.body);
      expect(body.model).toBe("deepseek-v4-pro");
      expect(body.thinking).toEqual({ type: "enabled" });
      expect(body.reasoning_effort).toBe("high");
      expect(body.response_format).toEqual({ type: "json_object" });
      expect(body.messages.map((m: { role: string }) => m.role)).toEqual([
        "system",
        "user",
      ]);
    }
    expect(
      JSON.parse(mocks.fetch.mock.calls[1][1].body).messages[1].content,
    ).toBe(JSON.stringify({ evidence, draft }));
    expect(JSON.stringify([written, reviewed])).not.toMatch(/synthetic-/);
  });

  it("retries an explicit temporary provider refusal once without changing the request", async () => {
    mocks.fetch
      .mockResolvedValueOnce(
        new Response(null, { status: 503, headers: { "Retry-After": "0" } }),
      )
      .mockResolvedValueOnce(complete(draft));
    const r = await callWeeklyReportModel(author);
    expect(r.value).toEqual(draft);
    expect(mocks.fetch.mock.calls[1]).toEqual(mocks.fetch.mock.calls[0]);
  });
  it("rejects source fields, arbitrary prompts and weaker result contracts before disclosure", async () => {
    await expect(
      callWeeklyReportModel({
        ...author,
        payload: { evidence, rawRecipe: "sentinel" },
      }),
    ).rejects.toThrow("projection rejected");
    await expect(
      callWeeklyReportModel({ ...author, system: "untrusted" }),
    ).rejects.toThrow("contract mismatch");
    await expect(
      callWeeklyReportModel({ ...author, schema: z.any() }),
    ).rejects.toThrow("contract mismatch");
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.decrypt).not.toHaveBeenCalled();
  });

  it("only decrypts the configured Pheno credential for the official provider", async () => {
    await expect(
      callWeeklyReportModel({ ...author, orgId: "other" }),
    ).rejects.toThrow("organization mismatch");
    mocks.activeProvider.mockResolvedValue({
      ...active,
      baseUrl: "https://untrusted.test",
    });
    await expect(callWeeklyReportModel(author)).rejects.toThrow(
      "provider unavailable",
    );
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.decrypt).not.toHaveBeenCalled();
  });

  it.each([
    ["fallback model", () => complete(draft, "deepseek-v4-flash")],
    ["cutoff", () => complete(draft, "deepseek-v4-pro", "length")],
    ["invalid verdict", () => complete({ extra: "synthetic-untrusted-text" })],
    ["bad JSON", () => new Response("synthetic-untrusted-text")],
    [
      "HTTP failure",
      () => new Response("synthetic-untrusted-text", { status: 400 }),
    ],
  ] as const)(
    "fails closed on %s without echoing vendor content",
    async (_label, response) => {
      mocks.fetch.mockResolvedValueOnce(response());
      const result = callWeeklyReportModel(author);
      await expect(result).rejects.toThrow(/Weekly/);
      await expect(result).rejects.not.toThrow(/synthetic-/);
      expect(mocks.fetch).toHaveBeenCalledTimes(1);
    },
  );
});

describe("private researcher and whole-paper referee", () => {
  const scienceEvidence = {
    followupRecords: [],
    publicEvidence: evidence,
    publicDraft: draft,
    cases: [
      {
        experiment: "E1",
        sourceHash: "1".repeat(64),
        title: "Synthetic molecular test",
        observation: "planned only",
        question: "which arm?",
        hypothesis: "synthetic",
        conclusion: "",
        testPlan: "synthetic",
        conditions: [],
        recipes: [],
        actualCaptures: false,
        materials: [
          {
            id: "M1",
            name: "test material",
            category: "SAM",
            association: ["selected-in-plan"],
            graph: {
              input: "synthetic-private-graph",
              hash: "2".repeat(64),
              version: 1,
              generatedAt: "2000-01-01",
              descriptor: {},
              motifs: {},
            },
          },
        ],
        recordedGroups: [],
      },
    ],
    articles: [],
  };
  it("separates approved private science calls and excludes account/credential data", async () => {
    const interpretation = {
      followupAssessments: [],
      cases: [],
      priorities: [{ en: "Repeat the comparison.", zh: "重复对照实验。" }],
    };
    const critique = { decision: "BLOCK", findings: [], scientificAudit: [] };
    mocks.fetch
      .mockResolvedValueOnce(complete(interpretation))
      .mockResolvedValueOnce(complete(critique));
    const write = await callWeeklyScienceModel({
      orgId: "test-org",
      role: "scientist",
      payload: { evidence: scienceEvidence },
    });
    const review = await callWeeklyScienceModel({
      orgId: "test-org",
      role: "chemist-reviewer",
      payload: { evidence: scienceEvidence, interpretation: write.value },
    });
    expect(write.evidenceHash).toBe(review.evidenceHash);
    expect(write.promptHash).not.toBe(review.promptHash);
    expect(write.completionId).not.toBe(review.completionId);
    expect(mocks.fetch.mock.calls[0][1].body).toContain(
      "synthetic-private-graph",
    );
    expect(JSON.stringify(write)).not.toContain("synthetic-private-graph");
    const withAccount = {
      ...scienceEvidence,
      cases: [
        { ...scienceEvidence.cases[0], authorEmail: "private@example.test" },
      ],
    };
    await expect(
      callWeeklyScienceModel({
        orgId: "test-org",
        role: "scientist",
        payload: { evidence: withAccount },
      }),
    ).rejects.toThrow("evidence rejected");
    for (const text of [
      "staff private@example.test",
      "Bearer mock-secret-longer-than-sixteen-characters",
    ]) {
      const withContact = {
        ...scienceEvidence,
        cases: [{ ...scienceEvidence.cases[0], observation: text }],
      };
      await expect(
        callWeeklyScienceModel({
          orgId: "test-org",
          role: "scientist",
          payload: { evidence: withContact },
        }),
      ).rejects.toThrow("credential or a personal address");
    }
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  const challenge = "a".repeat(64),
    contentSha256 = "b".repeat(64);
  const text = { en: "Numerical comparison", zh: "实验数值对比" };
  const packet = {
    reviewChecks: ["units"],
    challenge,
    challengeSha256: createHash("sha256").update(challenge).digest("hex"),
    contentSha256,
    period: { start: "2000-01-01", end: "2000-01-08", asOf: "2000-01-08" },
    title: text,
    abstract: text,
    sections: [{ id: "case-1", ...text }],
    sourceCases: [
      {
        code: "E1",
        sourceHash: "c".repeat(64),
        comparisonFacts: "four devices",
      },
    ],
    numericAudit: "observed synthetic numerical audit",
    materialReview: "source-bound synthetic chemistry",
    literature: "No literature claim in this synthetic fixture.",
  };
  const decision = {
    checks: [
      {
        key: "units",
        decision: "PASS",
        evidence: "All values use the reported experimental unit.",
      },
    ],
    decision: "PASS",
    challenge,
    contentSha256,
    sections: [
      {
        id: "case-1",
        observation: "Both versions describe the same sample count.",
        decision: "PASS",
      },
    ],
    assessments: [
      "numerical",
      "science",
      "chemistry",
      "source",
      "bilingual",
      "privacy",
    ].map((scope) => ({
      scope,
      evidence: "The sample statement matches its source.",
      decision: "PASS",
    })),
    findings: [],
  };
  it("checks a fresh whole-paper challenge, section coverage and six separate domains", async () => {
    mocks.fetch.mockResolvedValueOnce(complete(decision));
    const output = await callWeeklyFinalReview({
      orgId: "test-org",
      payload: packet,
    });
    expect(output.role).toBe("final-reviewer");
    expect(output.inputHash).toBe(hashWeeklyReportValue(packet));
    expect(output.outputHash).toBe(hashWeeklyReportValue(decision));
    expect(output.completionId).toMatch(/^[a-z\d-]+$/);
    expect(
      JSON.parse(mocks.fetch.mock.calls[0][1].body).messages[1].content,
    ).toContain("four devices");
  });
  it("rejects fabricated approval, wrong paper, missing scopes or omitted sections", async () => {
    for (const rejected of [
      { ...decision, challenge: "d".repeat(64) },
      { ...decision, contentSha256: "d".repeat(64) },
      {
        ...decision,
        assessments: [
          ...decision.assessments.slice(1),
          decision.assessments[1],
        ],
      },
      {
        ...decision,
        sections: [{ ...decision.sections[0], id: "wrong-case" }],
      },
      {
        ...decision,
        findings: [
          {
            severity: "blocking",
            issue: "Incorrect sample denominator.",
            correction: "Check the four physical devices.",
          },
        ],
      },
    ]) {
      mocks.fetch.mockResolvedValueOnce(complete(rejected));
      await expect(
        callWeeklyFinalReview({ orgId: "test-org", payload: packet }),
      ).rejects.toThrow("Final reviewer");
    }
  });
});
