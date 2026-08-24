import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/infrastructure/db/client";
import { executionBatchSchema } from "@/modules/runs/schema";
import { saveExecutionBatchService } from "@/modules/runs/service";

afterAll(async () => {
  await db.$disconnect();
});

describe("capture relational integrity", () => {
  it("rejects cross-experiment IDs and audits a valid capture", async () => {
    const suffix = crypto.randomUUID();
    const org = await db.organization.create({
      data: { name: "Capture Test Org", slug: `capture-${suffix}` },
    });
    const user = await db.user.create({
      data: {
        organizationId: org.id,
        email: `capture-owner-${suffix}@example.test`,
        name: "Capture Owner",
        passwordHash: "test-only",
        role: "MANAGER",
      },
    });
    const process = await db.process.create({
      data: {
        organizationId: org.id,
        name: `Spin coat ${suffix}`,
        kind: "PROCESSING",
      },
    });
    const experimentA = await db.experiment.create({
      data: {
        organizationId: org.id,
        code: `CAP-A-${suffix}`,
        title: "Capture A",
        createdById: user.id,
        samples: { create: { code: "S1" } },
        steps: {
          create: {
            position: 0,
            processId: process.id,
            name: "Step A",
          },
        },
        runs: { create: { runNo: 1, status: "IN_PROGRESS" } },
      },
      include: { samples: true, steps: true, runs: true },
    });
    const experimentB = await db.experiment.create({
      data: {
        organizationId: org.id,
        code: `CAP-B-${suffix}`,
        title: "Capture B",
        createdById: user.id,
        samples: { create: { code: "S1" } },
        steps: {
          create: {
            position: 0,
            processId: process.id,
            name: "Step B",
          },
        },
      },
      include: { samples: true, steps: true },
    });
    const actor = { uid: user.id, org: org.id, role: "MANAGER" } as const;
    const data = {
      actuals: { speed: "3000" },
      environmentConditions: { humidity: "20" },
      note: "captured",
      flagged: false,
    };

    try {
      await expect(
        saveExecutionBatchService(
          actor,
          executionBatchSchema.parse({
            runId: experimentA.runs[0].id,
            stepId: experimentB.steps[0].id,
            sampleIds: [experimentA.samples[0].id],
            data,
          }),
        ),
      ).rejects.toThrow(/same experiment/);

      const saved = await saveExecutionBatchService(
        actor,
        executionBatchSchema.parse({
          runId: experimentA.runs[0].id,
          stepId: experimentA.steps[0].id,
          sampleIds: [experimentA.samples[0].id],
          data,
        }),
      );
      expect(saved).toHaveLength(1);
      expect(
        await db.auditEvent.count({
          where: {
            organizationId: org.id,
            entityId: experimentA.runs[0].id,
            action: "capture.execution.save",
          },
        }),
      ).toBe(1);
    } finally {
      await db.auditEvent.deleteMany({ where: { organizationId: org.id } });
      await db.experiment.deleteMany({ where: { organizationId: org.id } });
      await db.process.deleteMany({ where: { organizationId: org.id } });
      await db.user.deleteMany({ where: { organizationId: org.id } });
      await db.organization.delete({ where: { id: org.id } });
    }
  });
});
