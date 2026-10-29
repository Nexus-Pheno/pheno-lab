import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chat } from "@/modules/ai/client";
import { isOfficialDeepSeek } from "@/modules/ai/provider-policy";
import { testAiProvider } from "@/modules/ai/service";

// Wire-format tests only. Authorization/transactions use the real database suite.
const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  update: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("@/infrastructure/db/client", () => ({
  db: {
    aiProvider: { findFirst: mocks.findFirst, update: mocks.update },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({ aiProvider: { update: mocks.update } }),
  },
}));
vi.mock("@/infrastructure/crypto/credential-server", () => ({
  decryptCredential: () => "synthetic-provider-key",
  encryptCredential: () => "synthetic-encrypted-key",
}));
vi.mock("@/modules/audit/writer", () => ({ recordUserAudit: mocks.audit }));

const provider = {
  id: "provider-one",
  organizationId: "organization-one",
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com",
  model: "synthetic-model",
  apiKey: "synthetic-encrypted-key",
  active: true,
};
const messages = [{ role: "user" as const, content: "Return a JSON object" }];
const fetchMock = vi.fn();
const finalAnswer = '{"purpose":{"en":"Review results","zh":"分析结果"}}';

beforeEach(() => {
  mocks.findFirst.mockReset().mockResolvedValue({ ...provider });
  mocks.update.mockReset().mockResolvedValue({ ...provider });
  mocks.audit.mockReset().mockResolvedValue(undefined);
  fetchMock.mockReset().mockResolvedValue(
    Response.json({
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: finalAnswer,
            reasoning_content: "PRIVATE_SENTINEL",
          },
        },
      ],
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function requestBody() {
  return JSON.parse(fetchMock.mock.calls[0][1].body);
}

describe("official DeepSeek capability boundary", () => {
  it.each([
    "https://api.deepseek.com",
    "https://api.deepseek.com/",
    "https://api.deepseek.com/v1",
    "https://api.deepseek.com/v1/",
  ])("accepts the official endpoint %s", (baseUrl) => {
    expect(isOfficialDeepSeek({ provider: "deepseek", baseUrl })).toBe(true);
  });

  it.each([
    "http://api.deepseek.com",
    "https://api.deepseek.com.example.test",
    "https://example.test/v1",
    "https://api.deepseek.com:8443",
    "https://user:secret@api.deepseek.com",
    "https://api.deepseek.com?proxy=1",
    "https://api.deepseek.com#fragment",
    "https://api.deepseek.com/proxy",
    "not a URL",
  ])("rejects nonofficial or modified endpoint %s", (baseUrl) => {
    expect(isOfficialDeepSeek({ provider: "deepseek", baseUrl })).toBe(false);
  });

  it("also requires the configured DeepSeek provider identity", () => {
    expect(isOfficialDeepSeek({ ...provider, provider: "custom" })).toBe(false);
  });
});

describe("scoped final JSON chat output", () => {
  it("requests bounded low-effort final JSON and returns only final content", async () => {
    const signal = new AbortController().signal;
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
    const result = await chat(provider.organizationId, messages, {
      structuredJson: true,
      maxTokens: 12000,
      timeoutMs: 110000,
    });
    expect(requestBody()).toEqual({
      model: provider.model,
      messages,
      max_tokens: 12000,
      temperature: 0,
      response_format: { type: "json_object" },
      reasoning_effort: "low",
    });
    expect(timeout).toHaveBeenCalledWith(110000);
    expect(result).toBe(finalAnswer);
    expect(result).not.toContain("PRIVATE_SENTINEL");
  });

  it("preserves ordinary chat request behavior", async () => {
    expect(await chat(provider.organizationId, messages)).toBe(finalAnswer);
    expect(requestBody()).toEqual({
      model: provider.model,
      messages,
      max_tokens: 400,
      temperature: 0,
    });
  });

  it.each([
    { provider: "deepseek", baseUrl: "https://proxy.example.test/v1" },
    { provider: "custom", baseUrl: "https://api.deepseek.com" },
  ])(
    "does not send vendor options to $provider at $baseUrl",
    async (target) => {
      mocks.findFirst.mockResolvedValue({ ...provider, ...target });
      await chat(provider.organizationId, messages, { structuredJson: true });
      expect(requestBody()).not.toHaveProperty("response_format");
      expect(requestBody()).not.toHaveProperty("reasoning_effort");
      expect(requestBody()).not.toHaveProperty("thinking");
    },
  );

  it.each([undefined, null, "", "  "])(
    "rejects absent or blank final content even with reasoning (%s)",
    async (content) => {
      fetchMock.mockResolvedValue(
        Response.json({
          choices: [
            {
              finish_reason: "stop",
              message: { content, reasoning_content: "PRIVATE_SENTINEL" },
            },
          ],
        }),
      );
      expect(
        await chat(provider.organizationId, messages, { structuredJson: true }),
      ).toBeNull();
    },
  );

  it("rejects a length-truncated final answer even when its JSON happens to parse", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        choices: [
          { finish_reason: "length", message: { content: finalAnswer } },
        ],
      }),
    );
    expect(
      await chat(provider.organizationId, messages, { structuredJson: true }),
    ).toBeNull();
  });

  it("retains the expected provider guard before a structured request", async () => {
    expect(
      await chat(provider.organizationId, messages, {
        structuredJson: true,
        expectedProvider: {
          id: "a-different-provider",
          model: provider.model,
          baseUrl: provider.baseUrl,
        },
      }),
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("tiny provider connection request", () => {
  const actor = {
    uid: "synthetic-admin",
    org: provider.organizationId,
    role: "ADMIN" as const,
  };
  it("disables reasoning only for the official DeepSeek probe", async () => {
    await testAiProvider(actor, provider.id);
    expect(requestBody().thinking).toEqual({ type: "disabled" });
    expect(requestBody().max_tokens).toBe(5);
    expect(requestBody()).not.toHaveProperty("reasoning_effort");
  });

  it("leaves another endpoint's probe unchanged", async () => {
    mocks.findFirst.mockResolvedValue({
      ...provider,
      baseUrl: "https://proxy.example.test/v1",
    });
    await testAiProvider(actor, provider.id);
    expect(requestBody()).not.toHaveProperty("thinking");
    expect(requestBody()).not.toHaveProperty("response_format");
    expect(requestBody().max_tokens).toBe(5);
  });
});
