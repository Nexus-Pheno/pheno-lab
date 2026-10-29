import "server-only";

import { db } from "@/infrastructure/db/client";
import { decryptCredential } from "@/infrastructure/crypto/credential-server";
import { isOfficialDeepSeek } from "./provider-policy";

// Server-only LLM access. Every feature goes through this domain client so the active
// provider, timeouts and failure handling are decided in one place.
//
// This is deliberately NOT used anywhere in the instrument ingest path —
// parsing, serial matching and metric selection stay deterministic, because a
// probabilistic step there would silently corrupt research numbers.

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

/** The organization's active model, or null when none is configured. */
export async function activeProvider(orgId: string) {
  return db.aiProvider.findFirst({
    where: { organizationId: orgId, active: true },
  });
}

/**
 * One chat completion. Returns null when no model is configured or the call
 * fails — every caller must have a working non-LLM path, so a missing key
 * degrades the feature rather than breaking it.
 */
export async function chat(
  orgId: string,
  messages: ChatMessage[],
  opts: {
    maxTokens?: number;
    temperature?: number;
    timeoutMs?: number;
    /** Opt-in final JSON output; vendor options are scoped to official DeepSeek. */
    structuredJson?: boolean;
    expectedProvider?: { id: string; model: string; baseUrl: string };
  } = {},
): Promise<string | null> {
  const p = await activeProvider(orgId);
  if (!p) return null;
  if (
    opts.expectedProvider &&
    (p.id !== opts.expectedProvider.id ||
      p.model !== opts.expectedProvider.model ||
      p.baseUrl !== opts.expectedProvider.baseUrl)
  )
    return null;
  const structuredDeepSeek = opts.structuredJson && isOfficialDeepSeek(p);
  try {
    const apiKey = decryptCredential(p.apiKey);
    const res = await fetch(`${p.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: p.model,
        messages,
        max_tokens: opts.maxTokens ?? 400,
        temperature: opts.temperature ?? 0,
        ...(structuredDeepSeek
          ? {
              response_format: { type: "json_object" },
              reasoning_effort: "low",
            }
          : {}),
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 25_000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    if (structuredDeepSeek && j?.choices?.[0]?.finish_reason === "length")
      return null;
    const text = j?.choices?.[0]?.message?.content;
    if (structuredDeepSeek && (typeof text !== "string" || !text.trim()))
      return null;
    return typeof text === "string" ? text : null;
  } catch {
    return null;
  }
}

/** Parse a JSON object out of a model reply, tolerating code fences. */
export function jsonFrom(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}
