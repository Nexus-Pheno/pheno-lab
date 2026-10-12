import "server-only";

import { createHmac } from "node:crypto";
import { z } from "zod";
import { serverConfig } from "@/infrastructure/config/server";
import { log } from "@/infrastructure/logging/logger";

const PREFIX = "【Pheno Lab】";
const responseSchema = z.object({
  errcode: z.union([
    z.number().int(),
    z
      .string()
      .regex(/^-?\d+$/)
      .transform(Number)
      .pipe(z.number().int()),
  ]),
});

export type DingTalkDestination = "general" | "jv-testing";

export function isDingTalkConfigured(
  destination: DingTalkDestination = "general",
): boolean {
  const config = serverConfig();
  return Boolean(
    destination === "jv-testing"
      ? config.DINGTALK_JV_WEBHOOK_URL
      : config.DINGTALK_WEBHOOK_URL,
  );
}

function signedUrl(webhookUrl: string, secret: string | undefined): string {
  const url = new URL(webhookUrl);
  if (!secret) return url.toString();
  const timestamp = Date.now().toString();
  const sign = createHmac("sha256", secret)
    .update(`${timestamp}\n${secret}`)
    .digest("base64");
  url.searchParams.set("timestamp", timestamp);
  url.searchParams.set("sign", sign);
  return url.toString();
}

export async function sendDingTalkText(
  content: string,
  destination: DingTalkDestination = "general",
): Promise<boolean> {
  let signal: AbortSignal | undefined;
  try {
    const config = serverConfig();
    const webhook =
      destination === "jv-testing"
        ? config.DINGTALK_JV_WEBHOOK_URL
        : config.DINGTALK_WEBHOOK_URL;
    const secret =
      destination === "jv-testing"
        ? config.DINGTALK_JV_WEBHOOK_SECRET
        : config.DINGTALK_WEBHOOK_SECRET;
    if (!webhook) return false;
    signal = AbortSignal.timeout(10_000);
    const response = await fetch(signedUrl(webhook, secret), {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        msgtype: "text",
        text: { content: `${PREFIX}${content}` },
      }),
      signal,
      redirect: "error",
    });
    if (!response.ok) {
      log.warn("dingtalk.send_failed", {
        reason: "http_error",
        status: response.status,
      });
      return false;
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      log.warn("dingtalk.send_failed", {
        reason: signal.aborted ? "timeout" : "invalid_response",
      });
      return false;
    }
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) {
      log.warn("dingtalk.send_failed", { reason: "invalid_response" });
      return false;
    }
    if (parsed.data.errcode !== 0) {
      log.warn("dingtalk.send_failed", {
        reason: "api_error",
        errcode: parsed.data.errcode,
      });
      return false;
    }
    return true;
  } catch {
    log.warn("dingtalk.send_failed", {
      reason: signal?.aborted ? "timeout" : "send_error",
    });
    return false;
  }
}
