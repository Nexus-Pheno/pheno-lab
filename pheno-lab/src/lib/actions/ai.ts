"use server";

import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { PROVIDER_PRESETS } from "@/lib/ai/presets";

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

async function requireAdmin() {
  const session = await requireSession();
  if (session.role !== "ADMIN") throw new Error("Only an administrator can manage AI providers.");
  return session;
}

function mask(key: string): string {
  const k = (key ?? "").trim();
  if (!k) return "";
  return k.length <= 6 ? "…" : `${k.slice(0, 3)}…${k.slice(-4)}`;
}

export async function listAiProviders(): Promise<AiProviderRow[]> {
  const session = await requireAdmin();
  const rows = await db.aiProvider.findMany({
    where: { organizationId: session.org },
    orderBy: [{ active: "desc" }, { createdAt: "asc" }],
  });
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    provider: r.provider,
    baseUrl: r.baseUrl,
    model: r.model,
    keyHint: mask(r.apiKey),
    active: r.active,
    lastStatus: r.lastStatus,
    lastCheckedAt: r.lastCheckedAt ? r.lastCheckedAt.toISOString().slice(0, 16).replace("T", " ") : null,
  }));
}

export async function saveAiProvider(data: {
  id?: string;
  label: string;
  provider: string;
  baseUrl: string;
  model: string;
  /** Blank on edit means "keep the stored key". */
  apiKey: string;
}) {
  const session = await requireAdmin();
  const clean = {
    label: data.label.trim() || data.provider,
    provider: data.provider,
    baseUrl: data.baseUrl.trim().replace(/\/+$/, ""),
    model: data.model.trim(),
  };
  if (!clean.baseUrl || !clean.model) throw new Error("Base URL and model are both required.");

  if (data.id) {
    const existing = await db.aiProvider.findFirst({
      where: { id: data.id, organizationId: session.org },
    });
    if (!existing) throw new Error("Provider not found.");
    await db.aiProvider.update({
      where: { id: data.id },
      // An empty key on edit must not wipe the stored one.
      data: { ...clean, ...(data.apiKey.trim() ? { apiKey: data.apiKey.trim() } : {}) },
    });
  } else {
    if (!data.apiKey.trim()) throw new Error("An API key is required.");
    const count = await db.aiProvider.count({ where: { organizationId: session.org } });
    await db.aiProvider.create({
      data: {
        ...clean,
        apiKey: data.apiKey.trim(),
        organizationId: session.org,
        createdById: session.uid,
        active: count === 0, // the first one configured becomes the active one
      },
    });
  }
  revalidatePath("/profile");
}

/** Exactly one provider is active at a time. */
export async function setActiveAiProvider(id: string) {
  const session = await requireAdmin();
  await db.$transaction([
    db.aiProvider.updateMany({ where: { organizationId: session.org }, data: { active: false } }),
    db.aiProvider.updateMany({ where: { id, organizationId: session.org }, data: { active: true } }),
  ]);
  revalidatePath("/profile");
}

export async function deleteAiProvider(id: string) {
  const session = await requireAdmin();
  await db.aiProvider.deleteMany({ where: { id, organizationId: session.org } });
  revalidatePath("/profile");
}

/**
 * Send a real (tiny) request so an admin learns the key works here and now,
 * rather than discovering it the first time a user asks a question.
 */
export async function testAiProvider(id: string): Promise<string> {
  const session = await requireAdmin();
  const p = await db.aiProvider.findFirst({ where: { id, organizationId: session.org } });
  if (!p) throw new Error("Provider not found.");
  let status = "";
  try {
    const res = await fetch(`${p.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.apiKey}` },
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
      status = reply ? `OK — replied “${String(reply).trim().slice(0, 40)}”` : "OK — empty reply";
    }
  } catch (e) {
    status = `Failed — ${e instanceof Error ? e.message : String(e)}`.slice(0, 160);
  }
  await db.aiProvider.update({
    where: { id },
    data: { lastStatus: status, lastCheckedAt: new Date() },
  });
  revalidatePath("/profile");
  return status;
}

/** True when this organization has a usable model configured. */
export async function hasActiveAiProvider(): Promise<boolean> {
  const session = await requireSession();
  return (await db.aiProvider.count({ where: { organizationId: session.org, active: true } })) > 0;
}

/**
 * Ask the provider which models it actually offers.
 *
 * The only list that is ever current is the vendor's own. Works with any
 * OpenAI-compatible /models endpoint (DeepSeek included); Anthropic wants its
 * own header, so both are attempted.
 */
export async function fetchAvailableModels(input: {
  id?: string;
  baseUrl?: string;
  apiKey?: string;
}): Promise<{ models: string[]; error: string }> {
  const session = await requireAdmin();
  let baseUrl = (input.baseUrl ?? "").trim().replace(/\/+$/, "");
  let apiKey = (input.apiKey ?? "").trim();

  // Editing an existing provider: use its stored key rather than asking the
  // admin to paste it again just to list models.
  if (input.id) {
    const p = await db.aiProvider.findFirst({ where: { id: input.id, organizationId: session.org } });
    if (p) {
      baseUrl = baseUrl || p.baseUrl;
      apiKey = apiKey || p.apiKey;
    }
  }
  if (!baseUrl || !apiKey) return { models: [], error: "A base URL and an API key are needed to list models." };

  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return { models: [], error: `HTTP ${res.status} — ${(await res.text()).slice(0, 120)}` };
    const j = await res.json();
    const list = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : [];
    const ids = list
      .map((m: unknown) => (typeof m === "string" ? m : (m as { id?: string })?.id))
      .filter((x: unknown): x is string => typeof x === "string" && x.length > 0)
      .sort();
    return { models: ids, error: ids.length ? "" : "The provider returned no models." };
  } catch (e) {
    return { models: [], error: e instanceof Error ? e.message : String(e) };
  }
}
