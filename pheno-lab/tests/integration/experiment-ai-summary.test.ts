import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/infrastructure/db/client";
import type { Actor } from "@/modules/authorization/actor";
import {
  generateAiSummary,
  getAiSummaryState,
  reviewAiSummary,
  startAiSummary,
  queueAutomaticAiSummary,
  drainPendingAiSummaries,
} from "@/modules/experiments/summary-service";

const ai = vi.hoisted(() => ({ chat: vi.fn(), activeProvider: vi.fn() }));
vi.mock("@/modules/ai/client", () => ({
  ...ai,
  jsonFrom: (text: string | null) => {
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  },
}));
const text = (en: string) => ({ en, zh: "对应的实验解释与验证建议。" });
const reply = (label = "Retain candidate for controlled repetition") =>
  JSON.stringify({
    purpose: text("Compare the candidate with its reference"),
    objectiveAttainment: text("Preliminary results support further validation"),
    groups: [
      {
        group: "B",
        judgment: text(label),
        mainIssue: text("Between-device consistency needs confirmation"),
        mechanisms: [text("Processing variation is a conditional explanation")],
        nextTest: text("Repeat the matched reference and candidate"),
        expectedOutcome: text(
          "A consistent improvement under matched conditions",
        ),
        decision: text(
          "Continue on repeated gains, otherwise adjust processing",
        ),
      },
    ],
  });

beforeEach(() => {
  ai.activeProvider.mockReset().mockResolvedValue({ model: "synthetic-model" });
  ai.chat.mockReset().mockResolvedValue(reply());
});
afterAll(async () => {
  await db.$disconnect();
});
async function fixture() {
  const suffix = crypto.randomUUID();
  const org = await db.organization.create({
    data: { name: "AI summary fixture", slug: `ai-summary-${suffix}` },
  });
  const user = await db.user.create({
    data: {
      organizationId: org.id,
      email: `owner-${suffix}@example.test`,
      name: "Owner",
      role: "TECHNICIAN",
      passwordHash: "test-only",
    },
  });
  const other = await db.user.create({
    data: {
      organizationId: org.id,
      email: `other-${suffix}@example.test`,
      name: "Other",
      role: "TECHNICIAN",
      passwordHash: "test-only",
    },
  });
  const owner: Actor = { uid: user.id, org: org.id, role: "TECHNICIAN" };
  const outsider: Actor = { uid: other.id, org: org.id, role: "TECHNICIAN" };
  const exp = await db.experiment.create({
    data: {
      organizationId: org.id,
      code: `AI-${suffix}`,
      title: "Synthetic candidate screening",
      status: "IN_LAB",
      createdById: owner.uid,
      metadata: {
        testPlan: {
          variables: [],
          groups: [
            { label: "A", isControl: true, samples: 1 },
            { label: "B", isControl: false, samples: 1 },
          ],
        },
      },
    },
  });
  const process = await db.process.create({
    data: {
      organizationId: org.id,
      name: "Synthetic JV",
      kind: "CHARACTERIZATION",
    },
  });
  const char = await db.characterization.create({
    data: {
      experimentId: exp.id,
      processId: process.id,
      name: "Synthetic JV",
      position: 0,
    },
  });
  const results = [];
  for (const [code, group, pce] of [
    ["S1", "A", 19],
    ["S2", "B", 20],
  ] as const) {
    const sample = await db.sample.create({
      data: { experimentId: exp.id, code, variationGroup: group },
    });
    results.push(
      await db.characterizationResult.create({
        data: {
          characterizationId: char.id,
          sampleId: sample.id,
          metrics: { "PCE (%)": String(pce), "Voc (V)": "1.1", "FF (%)": "78" },
        },
      }),
    );
  }
  return {
    org,
    owner,
    outsider,
    exp,
    process,
    results,
    cleanup: async () => {
      await db.auditEvent.deleteMany({ where: { organizationId: org.id } });
      await db.experiment.delete({ where: { id: exp.id } });
      await db.process.delete({ where: { id: process.id } });
      await db.user.deleteMany({ where: { organizationId: org.id } });
      await db.organization.delete({ where: { id: org.id } });
    },
  };
}
async function settle(actor: Actor, id: string) {
  for (let n = 0; n < 80; n++) {
    const state = await getAiSummaryState(actor, id);
    if (state?.run?.state !== "running") return state;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return getAiSummaryState(actor, id);
}

describe("versioned AI result interpretation against guarded PostgreSQL", () => {
  it("reserves final-output budget only for official DeepSeek summaries", async () => {
    const f = await fixture();
    try {
      for (const [provider, baseUrl, maxTokens, timeoutMs] of [
        ["deepseek", "https://api.deepseek.com", 12000, 110000],
        ["deepseek", "https://proxy.example.test/v1", 6500, 55000],
        ["custom", "https://api.deepseek.com", 6500, 55000],
      ] as const) {
        ai.activeProvider.mockResolvedValue({
          id: "synthetic-provider",
          provider,
          baseUrl,
          model: "synthetic-model",
        });
        const summary = await generateAiSummary(f.owner, f.exp.id, "en");
        expect(summary?.reviewState).toBe("draft");
        expect(ai.chat.mock.lastCall?.[2]).toMatchObject({
          structuredJson: true,
          maxTokens,
          timeoutMs,
        });
        const prompt = ai.chat.mock.lastCall?.[1][0].content;
        expect(prompt).toContain("only to deltaBestPce, never deltaMeanPce");
        expect(prompt).toContain(
          "shared by both groups is not a between-group difference or confound",
        );
        expect(prompt).toContain("repetitions at fixed conditions");
        expect(prompt).toContain("plan-implied comparison");
        expect(prompt).toContain(
          "Accepted device evidence governs numerical judgments",
        );
        expect(prompt).toContain(
          "result and judgment first, the most important concrete question second, a specific next test third",
        );
        expect(prompt).toContain("Keep these three roles separate");
        expect(prompt).toContain(
          "Do not repeat general measurement policy, snapshot/cutoff, statistics definitions or generic disclaimers",
        );
        expect(prompt).toContain("Uncertainty words are allowed when needed");
        expect(prompt).toContain(
          "If a limitation blocks attribution, bound the judgment",
        );
        expect(prompt).toContain("mean PCE improvement' / '平均PCE提高'");
        expect(prompt).toContain(
          "cannot distinguish a solvent effect without another solvent arm",
        );
        expect(prompt).toContain(
          "It does not prove the earlier gain was run/device variation",
        );
        expect(prompt).toContain(
          "An omitted field or a '[Restricted… omitted]'",
        );
        expect(prompt).toContain(
          "Only an explicit source status such as NOT_RECORDED",
        );
        expect(prompt).toContain("Every en field must be English prose");
        const payload = JSON.parse(ai.chat.mock.lastCall?.[1][1].content);
        expect(payload.inputScope).toContain(
          "Omission is not a source-record absence",
        );
        expect(summary?.promptVersion).toBe("concise-bilingual-results-v4");
      }
      ai.chat.mockResolvedValueOnce(null);
      expect(await generateAiSummary(f.owner, f.exp.id, "en")).toBeNull();
      const state = await getAiSummaryState(f.owner, f.exp.id);
      expect(state?.run?.state).toBe("failed");
      expect(state?.summary?.reviewState).toBe("draft");
      expect(state?.summary?.sourceHash).toBe(state?.evidenceHash);
    } finally {
      await f.cleanup();
    }
  });

  it("requires renewed review after the result-first prompt changes even when measurements are unchanged", async () => {
    const f = await fixture();
    try {
      const summary = await generateAiSummary(f.owner, f.exp.id, "en");
      expect(summary?.promptVersion).toBe("concise-bilingual-results-v4");
      await reviewAiSummary(f.owner, f.exp.id, summary!.sourceHash!);
      const row = await db.experiment.findUniqueOrThrow({
        where: { id: f.exp.id },
      });
      const meta = JSON.parse(JSON.stringify(row.metadata));
      meta.aiSummary.promptVersion = "concise-bilingual-results-v3";
      await db.experiment.update({
        where: { id: f.exp.id },
        data: { metadata: meta },
      });
      const old = await getAiSummaryState(f.owner, f.exp.id);
      expect(old?.evidenceHash).toBe(summary?.sourceHash);
      expect(old?.summary?.reviewState).toBe("reviewed");
      expect(old?.isStale).toBe(true);
      await expect(
        reviewAiSummary(f.owner, f.exp.id, summary!.sourceHash!),
      ).rejects.toThrow();
      const regenerated = await generateAiSummary(f.owner, f.exp.id, "en");
      expect(regenerated?.sourceHash).toBe(summary?.sourceHash);
      expect(regenerated?.promptVersion).toBe("concise-bilingual-results-v4");
      expect(regenerated?.reviewState).toBe("draft");
      expect((await getAiSummaryState(f.owner, f.exp.id))?.isStale).toBe(false);
    } finally {
      await f.cleanup();
    }
  });

  it("keeps an IN_LAB analysis advisory, supports review and detects child-result changes", async () => {
    const f = await fixture();
    try {
      const initial = await getAiSummaryState(f.owner, f.exp.id);
      expect(initial?.hasResults).toBe(true);
      const summary = await generateAiSummary(f.owner, f.exp.id, "en");
      expect(summary?.analysis?.groups[0].group).toBe("B");
      expect(summary?.interim).toBe(true);
      expect(summary?.reviewState).toBe("draft");
      expect(
        (await db.experiment.findUniqueOrThrow({ where: { id: f.exp.id } }))
          .status,
      ).toBe("IN_LAB");
      const reviewed = await reviewAiSummary(
        f.owner,
        f.exp.id,
        summary!.sourceHash!,
      );
      expect(reviewed.reviewState).toBe("reviewed");
      await db.characterizationResult.update({
        where: { id: f.results[1].id },
        data: { metrics: { "PCE (%)": "20.3" } },
      });
      expect((await getAiSummaryState(f.owner, f.exp.id))?.isStale).toBe(true);
      await expect(
        reviewAiSummary(f.owner, f.exp.id, summary!.sourceHash!),
      ).rejects.toThrow("Results changed");
      expect(
        await db.auditEvent.count({
          where: {
            organizationId: f.org.id,
            action: "experiment.aiSummary.reviewed",
          },
        }),
      ).toBe(1);
      const payload = ai.chat.mock.calls[0][1][1].content;
      expect(payload).not.toContain('"selectedResults"');
      expect(payload).not.toContain('"aiSummary"');
    } finally {
      await f.cleanup();
    }
  });

  it("denies foreign, uninvolved, restricted and deactivated accounts before a provider call", async () => {
    const f = await fixture();
    try {
      await expect(
        startAiSummary(f.outsider, f.exp.id, "en"),
      ).rejects.toThrow();
      await expect(
        startAiSummary({ ...f.owner, org: "foreign-org" }, f.exp.id, "en"),
      ).rejects.toThrow();
      await expect(
        startAiSummary({ ...f.owner, testingOnly: true }, f.exp.id, "en"),
      ).rejects.toThrow();
      await db.user.update({
        where: { id: f.owner.uid },
        data: { active: false },
      });
      await expect(startAiSummary(f.owner, f.exp.id, "en")).rejects.toThrow();
      expect(ai.chat).not.toHaveBeenCalled();
    } finally {
      await f.cleanup();
    }
  });

  it("rejects stale responses and never lets an older generation overwrite the latest one", async () => {
    const f = await fixture();
    let completeOld!: (text: string) => void;
    try {
      ai.chat.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            completeOld = resolve;
          }),
      );
      await startAiSummary(f.owner, f.exp.id, "en");
      for (let n = 0; n < 40 && !completeOld; n++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      await db.characterizationResult.update({
        where: { id: f.results[1].id },
        data: { metrics: { "PCE (%)": "20.4" } },
      });
      await startAiSummary(f.owner, f.exp.id, "en");
      const newest = await settle(f.owner, f.exp.id);
      expect(newest?.summary?.sourceHash).toBe(newest?.evidenceHash);
      completeOld(reply("Old response must be discarded"));
      await new Promise((resolve) => setTimeout(resolve, 100));
      const final = await getAiSummaryState(f.owner, f.exp.id);
      expect(final?.summary?.analysis?.groups[0].judgment.en).not.toContain(
        "Old response",
      );
      expect(final?.summary?.sourceHash).toBe(newest?.summary?.sourceHash);
    } finally {
      await f.cleanup();
    }
  });

  it("does not persist an answer after its requester's permission is revoked", async () => {
    const f = await fixture();
    let complete!: (text: string) => void;
    try {
      ai.chat.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      );
      await startAiSummary(f.owner, f.exp.id, "en");
      for (let n = 0; n < 40 && !complete; n++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      await db.user.update({
        where: { id: f.owner.uid },
        data: { active: false },
      });
      complete(reply());
      await new Promise((resolve) => setTimeout(resolve, 100));
      const e = await db.experiment.findUniqueOrThrow({
        where: { id: f.exp.id },
      });
      expect((e.metadata as Record<string, unknown>).aiSummary).toBeUndefined();
      expect(
        await db.auditEvent.count({
          where: { organizationId: f.org.id, action: "experiment.aiSummary" },
        }),
      ).toBe(0);
    } finally {
      await f.cleanup();
    }
  });

  it("fails honestly on invalid model output without replacing a prior summary", async () => {
    const f = await fixture();
    try {
      const old = await generateAiSummary(f.owner, f.exp.id, "en");
      ai.chat.mockResolvedValueOnce('{"groups":[]}');
      expect(await generateAiSummary(f.owner, f.exp.id, "en")).toBeNull();
      expect(
        (await getAiSummaryState(f.owner, f.exp.id))?.summary?.sourceHash,
      ).toBe(old?.sourceHash);
      expect((await getAiSummaryState(f.owner, f.exp.id))?.run?.state).toBe(
        "failed",
      );
    } finally {
      await f.cleanup();
    }
  });

  it("rejects stray Chinese in every English prose field without replacing or approving a prior summary", async () => {
    const f = await fixture();
    try {
      const old = await generateAiSummary(f.owner, f.exp.id, "en");
      const reviewed = await reviewAiSummary(
        f.owner,
        f.exp.id,
        old!.sourceHash!,
      );
      for (let index = 0; index < 8; index++) {
        const response = JSON.parse(reply());
        const group = response.groups[0];
        const fields = [
          response.purpose,
          response.objectiveAttainment,
          group.judgment,
          group.mainIssue,
          group.mechanisms[0],
          group.nextTest,
          group.expectedOutcome,
          group.decision,
        ];
        fields[index].en = "Keep 常规 annealing for the controlled repeat.";
        ai.chat.mockResolvedValueOnce(JSON.stringify(response));
        expect(await generateAiSummary(f.owner, f.exp.id, "en")).toBeNull();
        const state = await getAiSummaryState(f.owner, f.exp.id);
        expect(state?.run?.state).toBe("failed");
        expect(state?.summary).toEqual(reviewed);
        expect(ai.chat).toHaveBeenCalledTimes(index + 2);
      }
      expect(
        await db.auditEvent.count({
          where: { organizationId: f.org.id, action: "experiment.aiSummary" },
        }),
      ).toBe(1);
      expect(
        await db.auditEvent.count({
          where: {
            organizationId: f.org.id,
            action: "experiment.aiSummary.reviewed",
          },
        }),
      ).toBe(1);
    } finally {
      await f.cleanup();
    }
  });

  it("allows exact quoted source material names in English without allowing unrelated quoted Chinese prose", async () => {
    const f = await fixture();
    try {
      await db.experiment.update({
        where: { id: f.exp.id },
        data: {
          metadata: {
            testPlan: {
              variables: [
                {
                  kind: "material",
                  processId: f.process.id,
                  layer: "SAM",
                  parameter: "SAM material",
                  unit: "",
                  values: { A: "Reference-SAM", B: "合成候选甲" },
                },
              ],
              groups: [
                { label: "A", isControl: true, samples: 1 },
                { label: "B", isControl: false, samples: 1 },
              ],
            },
          },
        },
      });
      ai.chat.mockResolvedValueOnce(
        reply('Retain "合成候选甲" for a controlled repeat.'),
      );
      const accepted = await generateAiSummary(f.owner, f.exp.id, "en");
      expect(accepted?.analysis?.groups[0].judgment.en).toBe(
        'Retain "合成候选甲" for a controlled repeat.',
      );
      expect(accepted?.reviewState).toBe("draft");
      expect(ai.chat.mock.lastCall?.[1][1].content).toContain("合成候选甲");
      for (const english of [
        "Retain 合成候选甲 for a controlled repeat.",
        'Keep "常规" annealing for a controlled repeat.',
      ]) {
        ai.chat.mockResolvedValueOnce(reply(english));
        expect(await generateAiSummary(f.owner, f.exp.id, "en")).toBeNull();
        expect((await getAiSummaryState(f.owner, f.exp.id))?.summary).toEqual(
          accepted,
        );
      }
    } finally {
      await f.cleanup();
    }
  });

  it("does not treat a Chinese group identifier as mixed English prose", async () => {
    const f = await fixture();
    try {
      await db.sample.updateMany({
        where: { experimentId: f.exp.id, variationGroup: "B" },
        data: { variationGroup: "候选组" },
      });
      const response = JSON.parse(reply());
      response.groups[0].group = "候选组";
      response.groups[0].judgment.en =
        'Retain "候选组" for a controlled repeat.';
      ai.chat.mockResolvedValueOnce(JSON.stringify(response));
      const accepted = await generateAiSummary(f.owner, f.exp.id, "en");
      expect(accepted?.analysis?.groups[0].group).toBe("候选组");
      expect(accepted?.reviewState).toBe("draft");
    } finally {
      await f.cleanup();
    }
  });

  it("debounces automatic work, audits SYSTEM and skips already current evidence", async () => {
    const f = await fixture();
    try {
      await queueAutomaticAiSummary(f.org.id, f.exp.id);
      await queueAutomaticAiSummary(f.org.id, f.exp.id);
      let exp = await db.experiment.findUniqueOrThrow({
        where: { id: f.exp.id },
      });
      const metadata = exp.metadata as Record<string, unknown>;
      await db.experiment.update({
        where: { id: f.exp.id },
        data: {
          metadata: {
            ...metadata,
            aiAnalysisPending: {
              ...(metadata.aiAnalysisPending as object),
              dueAt: "2000-01-01T00:00:00Z",
            },
          },
        },
      });
      expect((await drainPendingAiSummaries()).started).toBe(1);
      const state = await settle(f.owner, f.exp.id);
      expect(state?.summary?.sourceHash).toBe(state?.evidenceHash);
      expect(
        await db.auditEvent.count({
          where: {
            organizationId: f.org.id,
            action: "experiment.aiSummary",
            actorType: "SYSTEM",
          },
        }),
      ).toBe(1);
      const calls = ai.chat.mock.calls.length;
      await queueAutomaticAiSummary(f.org.id, f.exp.id);
      exp = await db.experiment.findUniqueOrThrow({ where: { id: f.exp.id } });
      const current = exp.metadata as Record<string, unknown>;
      await db.experiment.update({
        where: { id: f.exp.id },
        data: {
          metadata: {
            ...current,
            aiAnalysisPending: {
              ...(current.aiAnalysisPending as object),
              dueAt: "2000-01-01T00:00:00Z",
            },
          },
        },
      });
      expect((await drainPendingAiSummaries()).started).toBe(0);
      expect(ai.chat.mock.calls.length).toBe(calls);
    } finally {
      await f.cleanup();
    }
  });
});
