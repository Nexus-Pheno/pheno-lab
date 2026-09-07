import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseServerConfig } from "@/infrastructure/config/schema";
import { serverConfig } from "@/infrastructure/config/server";
import { log } from "@/infrastructure/logging/logger";
import { isDingTalkConfigured, sendDingTalkText } from "./dingtalk";

vi.mock("@/infrastructure/config/server", () => ({ serverConfig: vi.fn() }));
vi.mock("@/infrastructure/logging/logger", () => ({
  log: { warn: vi.fn() },
}));

const webhookUrl =
  "https://oapi.dingtalk.com/robot/send?access_token=unit-test-token";
const fetchMock = vi.fn<typeof fetch>();

function configure(environment: Partial<NodeJS.ProcessEnv> = {}) {
  vi.mocked(serverConfig).mockReturnValue(
    parseServerConfig({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://127.0.0.1:5432/pheno_lab_test",
      SESSION_SECRET: "unit-test-session-secret-over-32-characters",
      DINGTALK_WEBHOOK_URL: webhookUrl,
      ...environment,
    }),
  );
}

beforeEach(() => {
  configure();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(Response.json({ errcode: 0, errmsg: "ok" }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("DingTalk adapter", () => {
  it("does nothing when the webhook is not configured", async () => {
    configure({ DINGTALK_WEBHOOK_URL: undefined });
    expect(isDingTalkConfigured()).toBe(false);
    await expect(sendDingTalkText("测试消息")).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("sends UTF-8 text with the keyword prefix and blocks redirects", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    expect(isDingTalkConfigured()).toBe(true);
    await expect(sendDingTalkText("测试消息")).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        msgtype: "text",
        text: { content: "【Pheno Lab】测试消息" },
      }),
      signal: expect.any(AbortSignal),
      redirect: "error",
    });
    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("signs the millisecond timestamp and secret without double encoding", async () => {
    configure({ DINGTALK_WEBHOOK_SECRET: "SECunit-test-secret" });
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    await expect(sendDingTalkText("Signed message")).resolves.toBe(true);
    const sentUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(sentUrl.searchParams.get("access_token")).toBe("unit-test-token");
    expect(sentUrl.searchParams.get("timestamp")).toBe("1700000000000");
    expect(sentUrl.searchParams.get("sign")).toBe(
      createHmac("sha256", "SECunit-test-secret")
        .update("1700000000000\nSECunit-test-secret")
        .digest("base64"),
    );
    expect(sentUrl.searchParams.getAll("sign")).toHaveLength(1);
  });

  it("accepts the documented string representation of a success code", async () => {
    fetchMock.mockResolvedValue(Response.json({ errcode: "0", errmsg: "ok" }));
    await expect(sendDingTalkText("Message")).resolves.toBe(true);
  });

  it.each([
    null,
    {},
    [],
    { errcode: null },
    { errcode: false },
    { errcode: "" },
    { errcode: "ok" },
    { errcode: 0.5 },
  ])(
    "rejects malformed responses rather than reporting success: %j",
    async (body) => {
      fetchMock.mockResolvedValue(Response.json(body));
      await expect(sendDingTalkText("Message")).resolves.toBe(false);
      expect(log.warn).toHaveBeenCalledWith("dingtalk.send_failed", {
        reason: "invalid_response",
      });
    },
  );

  it("handles invalid JSON without logging the response body", async () => {
    fetchMock.mockResolvedValue(new Response("private response body"));
    await expect(sendDingTalkText("Message")).resolves.toBe(false);
    expect(log.warn).toHaveBeenCalledExactlyOnceWith("dingtalk.send_failed", {
      reason: "invalid_response",
    });
  });

  it.each([302, 429, 503])(
    "handles HTTP %s without retrying or reading error text",
    async (status) => {
      fetchMock.mockResolvedValue(
        new Response("private response body", { status }),
      );
      await expect(sendDingTalkText("Message")).resolves.toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(log.warn).toHaveBeenCalledExactlyOnceWith("dingtalk.send_failed", {
        reason: "http_error",
        status,
      });
    },
  );

  it.each([310000, "310000"])(
    "logs only the numeric API error code",
    async (errcode) => {
      fetchMock.mockResolvedValue(
        Response.json({
          errcode,
          errmsg: `${webhookUrl} private-message-content`,
        }),
      );
      await expect(sendDingTalkText("Message")).resolves.toBe(false);
      expect(log.warn).toHaveBeenCalledExactlyOnceWith("dingtalk.send_failed", {
        reason: "api_error",
        errcode: 310000,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("contains network failures without leaking credentials or message text", async () => {
    fetchMock.mockRejectedValue(
      new Error(`${webhookUrl} private-message-content`),
    );
    await expect(sendDingTalkText("private-message-content")).resolves.toBe(
      false,
    );
    expect(log.warn).toHaveBeenCalledExactlyOnceWith("dingtalk.send_failed", {
      reason: "send_error",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts a stalled request using the timeout signal", async () => {
    const controller = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(controller.signal);
    fetchMock.mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    const sending = sendDingTalkText("Message");
    controller.abort(new Error(webhookUrl));
    await expect(sending).resolves.toBe(false);
    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(log.warn).toHaveBeenCalledExactlyOnceWith("dingtalk.send_failed", {
      reason: "timeout",
    });
  });

  it("contains configuration failures before attempting delivery", async () => {
    vi.mocked(serverConfig).mockImplementation(() => {
      throw new Error(webhookUrl);
    });
    await expect(sendDingTalkText("Message")).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledExactlyOnceWith("dingtalk.send_failed", {
      reason: "send_error",
    });
  });
});
