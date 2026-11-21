import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  callWeeklyReportModel,
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
      () => new Response("synthetic-untrusted-text", { status: 429 }),
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
