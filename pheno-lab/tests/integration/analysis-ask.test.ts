import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/infrastructure/db/client";
import type { Actor, ActorRole } from "@/modules/authorization/actor";
import {
  getAnalysisRun,
  listAnalysisRuns,
  startAnalysisRun,
} from "@/modules/analysis/ask-service";

afterAll(async () => {
  await db.$disconnect();
});

async function removeOrganization(organizationId: string): Promise<void> {
  await db.auditEvent.deleteMany({ where: { organizationId } });
  await db.analysisRun.deleteMany({ where: { organizationId } });
  await db.experiment.deleteMany({ where: { organizationId } });
  await db.user.deleteMany({ where: { organizationId } });
  await db.organization.delete({ where: { id: organizationId } });
}

async function fixture(slug: string) {
  const suffix = crypto.randomUUID();
  const organization = await db.organization.create({
    data: { name: `Ask ${slug}`, slug: `${slug}-${suffix}` },
  });
  const person = async (label: string, role: ActorRole): Promise<Actor> => {
    const user = await db.user.create({
      data: {
        organizationId: organization.id,
        email: `${label}-${suffix}@example.test`,
        name: label,
        passwordHash: "test-only",
        role,
      },
    });
    return { uid: user.id, org: organization.id, role };
  };
  return { organization, technician: await person("Tech", "TECHNICIAN") };
}

const settle = async (actor: Actor, id: string) => {
  for (let i = 0; i < 40; i += 1) {
    const run = await getAnalysisRun(actor, id);
    if (run && run.status !== "RUNNING") return run;
    await new Promise((r) => setTimeout(r, 250));
  }
  return getAnalysisRun(actor, id);
};

describe("free-form analysis runs against PostgreSQL", () => {
  it("records the question, runs detached, and fails honestly without a provider", async () => {
    const f = await fixture("run");
    try {
      // Any role may ask — the analysis surface is org-wide by decision.
      const run = await startAnalysisRun(f.technician, {
        question: "刮涂 HTL 是否优于旋涂？",
        lang: "zh",
      });
      expect(run.status).toBe("RUNNING");
      expect(run.requestedBy).toBe("Tech");

      // No AI provider is configured in tests, so the detached generation
      // must land on FAILED rather than hang or pretend.
      const done = await settle(f.technician, run.id);
      expect(done?.status).toBe("FAILED");
      expect(done?.finishedAt).not.toBeNull();

      const history = await listAnalysisRuns(f.technician);
      expect(history.map((r) => r.id)).toContain(run.id);
      expect(
        await db.auditEvent.count({
          where: {
            organizationId: f.organization.id,
            action: "analysis.asked",
          },
        }),
      ).toBe(1);
    } finally {
      await removeOrganization(f.organization.id);
    }
  });

  it("keeps runs inside their organization and retires a crashed one", async () => {
    const mine = await fixture("mine");
    const theirs = await fixture("theirs");
    try {
      const run = await startAnalysisRun(mine.technician, {
        question: "What did the anneal temperature do?",
        lang: "en",
      });
      expect(await getAnalysisRun(theirs.technician, run.id)).toBeNull();
      expect(
        (await listAnalysisRuns(theirs.technician)).map((r) => r.id),
      ).not.toContain(run.id);

      await settle(mine.technician, run.id);
      // Simulate a run whose process died: RUNNING and older than the cutoff.
      await db.analysisRun.update({
        where: { id: run.id },
        data: {
          status: "RUNNING",
          finishedAt: null,
          startedAt: new Date(Date.now() - 10 * 60_000),
        },
      });
      const read = await getAnalysisRun(mine.technician, run.id);
      expect(read?.status).toBe("FAILED");
    } finally {
      await removeOrganization(mine.organization.id);
      await removeOrganization(theirs.organization.id);
    }
  });

  it("rejects a question too short to retrieve on", async () => {
    const f = await fixture("short");
    try {
      await expect(
        startAnalysisRun(f.technician, { question: "a", lang: "zh" }),
      ).rejects.toThrow();
    } finally {
      await removeOrganization(f.organization.id);
    }
  });
});
