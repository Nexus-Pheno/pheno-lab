import "server-only";

import { db } from "@/infrastructure/db/client";
import {
  decryptCredential,
  encryptCredential,
} from "@/infrastructure/crypto/credential-server";
import type { Actor } from "@/modules/authorization/actor";
import { assertAdmin } from "@/modules/authorization/policy";
import { recordUserAudit } from "@/modules/audit/writer";
import {
  aiModelListSchema,
  aiProviderIdSchema,
  aiProviderSaveSchema,
} from "./schema";

// LLM provider settings for an organization.
//
// API keys are write-only from the browser's point of view: they go in, they
// are never sent back. Every read returns a masked hint (last four characters)
// so an admin can tell which key is stored without the key being exposed to
// the page, to a screenshot, or to anyone with the browser devtools open.

export type AiProviderRow = {
  id: string;
  label: string;
  provider: string;
  baseUrl: string;
  model: string;
  /** Masked — e.g. "sk-…4f2a". Never the real key. */
  keyHint: string;
  active: boolean;
  lastStatus: string;
  lastCheckedAt: string | null;
};

function mask(key: string): string {
  const k = (key ?? "").trim();
  if (!k) return "";
  return k.length <= 6 ? "…" : `${k.slice(0, 3)}…${k.slice(-4)}`;
}

export async function listAiProviders(actor: Actor): Promise<AiProviderRow[]> {
  assertAdmin(actor);
  const rows = await db.aiProvider.findMany({
    where: { organizationId: actor.org },
    orderBy: [{ active: "desc" }, { createdAt: "asc" }],
  });
  return rows.map((r) => {
    const apiKey = decryptCredential(r.apiKey);
    return {
      id: r.id,
      label: r.label,
      provider: r.provider,
      baseUrl: r.baseUrl,
      model: r.model,
      keyHint: mask(apiKey),
      active: r.active,
      lastStatus: r.lastStatus,
      lastCheckedAt: r.lastCheckedAt
        ? r.lastCheckedAt.toISOString().slice(0, 16).replace("T", " ")
        : null,
    };
  });
}

export async function saveAiProvider(
  actor: Actor,
  raw: {
    id?: string;
    label: string;
    provider: string;
    baseUrl: string;
    model: string;
    /** Blank on edit means "keep the stored key". */
    apiKey: string;
  },
) {
  assertAdmin(actor);
  const data = aiProviderSaveSchema.parse(raw);
  const clean = {
    label: data.label.trim() || data.provider,
    provider: data.provider,
    baseUrl: data.baseUrl.trim().replace(/\/+$/, ""),
    model: data.model.trim(),
  };
  if (!clean.baseUrl || !clean.model)
    throw new Error("Base URL and model are both required.");

  if (data.id) {
    const providerId = data.id;
    await db.$transaction(async (tx) => {
      const existing = await tx.aiProvider.findFirst({
        where: { id: providerId, organizationId: actor.org },
      });
      if (!existing) throw new Error("Provider not found.");
      await tx.aiProvider.update({
        where: { id: providerId },
        data: {
          ...clean,
          ...(data.apiKey ? { apiKey: encryptCredential(data.apiKey) } : {}),
        },
      });
      await recordUserAudit(tx, {
        actor,
        action: "ai.provider.updated",
        entityType: "AiProvider",
        entityId: providerId,
        changes: clean,
      });
    });
  } else {
    if (!data.apiKey) throw new Error("An API key is required.");
    await db.$transaction(async (tx) => {
      const count = await tx.aiProvider.count({
        where: { organizationId: actor.org },
      });
      const row = await tx.aiProvider.create({
        data: {
          ...clean,
          apiKey: encryptCredential(data.apiKey),
          organizationId: actor.org,
          createdById: actor.uid,
          active: count === 0,
        },
      });
      await recordUserAudit(tx, {
        actor,
        action: "ai.provider.created",
        entityType: "AiProvider",
        entityId: row.id,
        changes: clean,
      });
    });
  }
}

/** Exactly one provider is active at a time. */
export async function setActiveAiProvider(actor: Actor, rawId: unknown) {
  assertAdmin(actor);
  const id = aiProviderIdSchema.parse(rawId);
  await db.$transaction(async (tx) => {
    const target = await tx.aiProvider.count({
      where: { id, organizationId: actor.org },
    });
    if (!target) throw new Error("Provider not found.");
    await tx.aiProvider.updateMany({
      where: { organizationId: actor.org },
      data: { active: false },
    });
    await tx.aiProvider.updateMany({
      where: { id, organizationId: actor.org },
      data: { active: true },
    });
    await recordUserAudit(tx, {
      actor,
      action: "ai.provider.activated",
      entityType: "AiProvider",
      entityId: id,
    });
  });
}

export async function deleteAiProvider(actor: Actor, rawId: unknown) {
  assertAdmin(actor);
  const id = aiProviderIdSchema.parse(rawId);
  await db.$transaction(async (tx) => {
    const result = await tx.aiProvider.deleteMany({
      where: { id, organizationId: actor.org },
    });
    if (result.count !== 1) throw new Error("Provider not found.");
    await recordUserAudit(tx, {
      actor,
      action: "ai.provider.deleted",
      entityType: "AiProvider",
      entityId: id,
    });
  });
}

/**
 * Send a real (tiny) request so an admin learns the key works here and now,
 * rather than discovering it the first time a user asks a question.
 */
export async function testAiProvider(
  actor: Actor,
  rawId: unknown,
): Promise<string> {
  assertAdmin(actor);
  const id = aiProviderIdSchema.parse(rawId);
  const p = await db.aiProvider.findFirst({
    where: { id, organizationId: actor.org },
  });
  if (!p) throw new Error("Provider not found.");
  let status = "";
  const apiKey = decryptCredential(p.apiKey);
  try {
    const res = await fetch(`${p.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: p.model,
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
        max_tokens: 5,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const body = await res.text();
      status = `HTTP ${res.status} — ${body.slice(0, 120)}`;
    } else {
      const j = await res.json();
      const reply = j?.choices?.[0]?.message?.content ?? "";
      status = reply
        ? `OK — replied “${String(reply).trim().slice(0, 40)}”`
        : "OK — empty reply";
    }
  } catch (e) {
    status = `Failed — ${e instanceof Error ? e.message : String(e)}`.slice(
      0,
      160,
    );
  }
  await db.$transaction(async (tx) => {
    await tx.aiProvider.update({
      where: { id },
      data: { lastStatus: status, lastCheckedAt: new Date() },
    });
    await recordUserAudit(tx, {
      actor,
      action: "ai.provider.tested",
      entityType: "AiProvider",
      entityId: id,
      metadata: { ok: status.startsWith("OK") },
    });
  });
  return status;
}

/** True when this organization has a usable model configured. */
export async function hasActiveAiProvider(actor: Actor): Promise<boolean> {
  return (
    (await db.aiProvider.count({
      where: { organizationId: actor.org, active: true },
    })) > 0
  );
}

/**
 * Ask the provider which models it actually offers.
 *
 * The only list that is ever current is the vendor's own. Works with any
 * OpenAI-compatible /models endpoint (DeepSeek included); Anthropic wants its
 * own header, so both are attempted.
 */
export async function fetchAvailableModels(
  actor: Actor,
  raw: {
    id?: string;
    baseUrl?: string;
    apiKey?: string;
  },
): Promise<{ models: string[]; error: string }> {
  assertAdmin(actor);
  const input = aiModelListSchema.parse(raw);
  let baseUrl = (input.baseUrl ?? "").trim().replace(/\/+$/, "");
  let apiKey = (input.apiKey ?? "").trim();

  // Editing an existing provider: use its stored key rather than asking the
  // admin to paste it again just to list models.
  if (input.id) {
    const p = await db.aiProvider.findFirst({
      where: { id: input.id, organizationId: actor.org },
    });
    if (p) {
      baseUrl = baseUrl || p.baseUrl;
      apiKey = apiKey || decryptCredential(p.apiKey);
    }
  }
  if (!baseUrl || !apiKey)
    return {
      models: [],
      error: "A base URL and an API key are needed to list models.",
    };

  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok)
      return {
        models: [],
        error: `HTTP ${res.status} — ${(await res.text()).slice(0, 120)}`,
      };
    const j = await res.json();
    const list = Array.isArray(j?.data)
      ? j.data
      : Array.isArray(j?.models)
        ? j.models
        : [];
    const ids = list
      .map((m: unknown) =>
        typeof m === "string" ? m : (m as { id?: string })?.id,
      )
      .filter(
        (x: unknown): x is string => typeof x === "string" && x.length > 0,
      )
      .sort();
    return {
      models: ids,
      error: ids.length ? "" : "The provider returned no models.",
    };
  } catch (e) {
    return { models: [], error: e instanceof Error ? e.message : String(e) };
  }
}
