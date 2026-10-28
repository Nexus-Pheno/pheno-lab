import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/infrastructure/db/client";
import { exportReportEvidence } from "@/modules/reports/evidence-query";
import {
  AI_SUMMARY_PROMPT_VERSION,
  AI_SUMMARY_RULE_VERSION,
} from "@/modules/experiments/summary-types";

afterAll(() => db.$disconnect());

async function fixture() {
  const suffix = crypto.randomUUID();
  const org = await db.organization.create({
    data: { name: "Evidence fixture", slug: `evidence-${suffix}` },
  });
  const user = await db.user.create({
    data: {
      organizationId: org.id,
      name: "Evidence reader",
      email: `evidence-${suffix}@example.test`,
      passwordHash: "test-only",
      role: "ADMIN",
      reportAccess: true,
    },
  });
  const experiment = await db.experiment.create({
    data: {
      organizationId: org.id,
      createdById: user.id,
      code: `SYN-EVIDENCE-${suffix}`,
      title: "Synthetic evidence fixture",
      status: "IN_LAB",
    },
  });
  const input = {
    organizationSlug: org.slug,
    readerEmail: user.email,
    experimentCodes: [experiment.code],
    sourceSnapshotAt: "2026-01-01T01:00:00Z",
    reportWindowEnd: "2026-01-01T00:00:00Z",
  };
  return {
    org,
    user,
    experiment,
    input,
    async cleanup() {
      await db.experiment.deleteMany({ where: { organizationId: org.id } });
      await db.auditEvent.deleteMany({ where: { organizationId: org.id } });
      await db.user.deleteMany({ where: { organizationId: org.id } });
      await db.organization.delete({ where: { id: org.id } });
    },
  };
}

describe("read-only shared report evidence on guarded PostgreSQL", () => {
  it("exports the exact app evidence without writing summaries, audits or grants", async () => {
    const f = await fixture();
    try {
      const before = await db.experiment.findUniqueOrThrow({
        where: { id: f.experiment.id },
      });
      const result = await exportReportEvidence(f.input);
      expect(result).toMatchObject({
        readOnly: true,
        methodVersion: "pheno-device-evidence-2026-10-28",
        selectionScope: "EXPERIMENT_CURRENT_ACCEPTED_RESULTS_AT_SNAPSHOT",
        bounds: { experiments: 1 },
      });
      expect(result.experiments[0].evidence.sourceHash).toMatch(
        /^[a-f0-9]{64}$/,
      );
      expect(result.experiments[0].aiInterpretation).toMatchObject({
        available: false,
        sourceHashMatches: false,
        versionCurrent: false,
        reviewState: "draft",
      });
      expect(
        await db.experiment.findUniqueOrThrow({ where: { id: before.id } }),
      ).toEqual(before);
      expect(
        await db.auditEvent.count({ where: { organizationId: f.org.id } }),
      ).toBe(0);
      expect(
        await db.notification.count({ where: { organizationId: f.org.id } }),
      ).toBe(0);
    } finally {
      await f.cleanup();
    }
  });

  it("separates current source from superseded AI analysis rules", async () => {
    const f = await fixture();
    try {
      const initial = await exportReportEvidence(f.input);
      const evidence = initial.experiments[0].evidence;
      const summary = {
        text: "Synthetic reviewed interpretation",
        lang: "en",
        generatedAt: "2026-01-01T00:00:00Z",
        sourceHash: evidence.sourceHash,
        policyVersion: evidence.policyVersion,
        ruleVersion: "superseded-rule",
        promptVersion: AI_SUMMARY_PROMPT_VERSION,
        reviewState: "reviewed",
      };
      await db.experiment.update({
        where: { id: f.experiment.id },
        data: { metadata: { aiSummary: summary } },
      });
      const oldVersion = await exportReportEvidence(f.input);
      expect(oldVersion.experiments[0].aiInterpretation).toMatchObject({
        sourceHashMatches: true,
        selectionMatchesPrimaryEvidence: true,
        versionCurrent: false,
        reviewState: "reviewed",
      });
      await db.experiment.update({
        where: { id: f.experiment.id },
        data: {
          metadata: {
            aiSummary: { ...summary, ruleVersion: AI_SUMMARY_RULE_VERSION },
          },
        },
      });
      expect(
        (await exportReportEvidence(f.input)).experiments[0].aiInterpretation
          .versionCurrent,
      ).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  it("rechecks explicit report grants and account restrictions, with no admin bypass", async () => {
    const f = await fixture();
    try {
      await db.user.update({
        where: { id: f.user.id },
        data: { reportAccess: false },
      });
      await expect(exportReportEvidence(f.input)).rejects.toThrow();
      await db.user.update({
        where: { id: f.user.id },
        data: { reportAccess: true, testingOnly: true },
      });
      await expect(exportReportEvidence(f.input)).rejects.toThrow();
      await db.user.update({
        where: { id: f.user.id },
        data: { testingOnly: false, role: "TECHNICIAN" },
      });
      // Report viewing alone is not authority to collect full experiment facts.
      await expect(exportReportEvidence(f.input)).rejects.toThrow();
    } finally {
      await f.cleanup();
    }
  });

  it("rejects unavailable organization scope and malformed/unbounded requests", async () => {
    const f = await fixture();
    try {
      await expect(
        exportReportEvidence({ ...f.input, organizationSlug: "another-org" }),
      ).rejects.toThrow();
      await expect(
        exportReportEvidence({ ...f.input, experimentCodes: ["missing-code"] }),
      ).rejects.toThrow();
      await expect(
        exportReportEvidence({
          ...f.input,
          experimentCodes: Array(251).fill("X"),
        }),
      ).rejects.toThrow();
      await expect(
        exportReportEvidence({ ...f.input, sourceSnapshotAt: "not-a-date" }),
      ).rejects.toThrow();
    } finally {
      await f.cleanup();
    }
  });
});
