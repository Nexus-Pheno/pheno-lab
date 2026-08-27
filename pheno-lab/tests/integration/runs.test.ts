import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/infrastructure/db/client";
import { AuthorizationError } from "@/modules/authorization/policy";
import {
  getCaptureRunData,
  getResultsExperiment,
} from "@/modules/experiments/query";
import { executionBatchSchema } from "@/modules/runs/schema";
import {
  cancelRunService,
  saveExecutionBatchService,
} from "@/modules/runs/service";

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

describe("run cancellation", () => {
  it("hides a cancelled run, preserves its records, audits it, and protects the last run", async () => {
    const suffix = crypto.randomUUID();
    const [organization, foreignOrganization] = await Promise.all([
      db.organization.create({
        data: { name: "Run Test Org", slug: `run-${suffix}` },
      }),
      db.organization.create({
        data: { name: "Foreign Run Org", slug: `run-foreign-${suffix}` },
      }),
    ]);
    const [owner, intruder] = await Promise.all([
      db.user.create({
        data: {
          organizationId: organization.id,
          email: `run-owner-${suffix}@example.test`,
          name: "Run Owner",
          passwordHash: "test-only",
          role: "MANAGER",
        },
      }),
      db.user.create({
        data: {
          organizationId: foreignOrganization.id,
          email: `run-intruder-${suffix}@example.test`,
          name: "Run Intruder",
          passwordHash: "test-only",
          role: "ADMIN",
        },
      }),
    ]);
    const process = await db.process.create({
      data: {
        organizationId: organization.id,
        name: `Run process ${suffix}`,
        kind: "PROCESSING",
      },
    });
    const experiment = await db.experiment.create({
      data: {
        organizationId: organization.id,
        code: `RUN-${suffix}`,
        title: "Run cancellation",
        createdById: owner.id,
        samples: { create: { code: "S1" } },
        steps: {
          create: { position: 0, processId: process.id, name: "Step" },
        },
        characterizations: {
          create: {
            position: 0,
            processId: process.id,
            name: "Result",
          },
        },
        runs: {
          create: [
            { runNo: 1, status: "IN_PROGRESS" },
            { runNo: 2, status: "IN_PROGRESS" },
          ],
        },
      },
      include: {
        samples: true,
        steps: true,
        characterizations: true,
        runs: { orderBy: { runNo: "asc" } },
      },
    });
    const [run1, run2] = experiment.runs;
    const actor = {
      uid: owner.id,
      org: organization.id,
      role: "MANAGER",
    } as const;
    const foreignActor = {
      uid: intruder.id,
      org: foreignOrganization.id,
      role: "ADMIN",
    } as const;

    try {
      await db.stepExecution.create({
        data: {
          runId: run2.id,
          stepId: experiment.steps[0].id,
          sampleId: experiment.samples[0].id,
          actuals: { speed: "3000" },
        },
      });
      await db.characterizationResult.create({
        data: {
          characterizationId: experiment.characterizations[0].id,
          runId: run2.id,
          sampleId: experiment.samples[0].id,
          metrics: { pce: "20" },
        },
      });

      await expect(
        cancelRunService(foreignActor, run2.id),
      ).rejects.toBeInstanceOf(AuthorizationError);
      expect(
        await db.run.findUniqueOrThrow({ where: { id: run2.id } }),
      ).toMatchObject({ status: "IN_PROGRESS" });

      await expect(cancelRunService(actor, run2.id)).resolves.toEqual({
        nextRunId: run1.id,
      });
      expect(
        await db.run.findUniqueOrThrow({ where: { id: run2.id } }),
      ).toMatchObject({ status: "CANCELLED" });
      expect(await db.stepExecution.count({ where: { runId: run2.id } })).toBe(
        1,
      );
      expect(
        await db.characterizationResult.count({ where: { runId: run2.id } }),
      ).toBe(1);
      expect(
        await db.auditEvent.count({
          where: {
            organizationId: organization.id,
            entityId: run2.id,
            action: "run.cancel",
          },
        }),
      ).toBe(1);

      const capture = await getCaptureRunData(actor, experiment.id, run2.id);
      expect(capture.runs.map((run) => run.id)).toEqual([run1.id]);
      expect(capture.run.id).toBe(run1.id);

      const results = await getResultsExperiment(actor, experiment.id);
      expect(results?.characterizations[0].results).toHaveLength(0);

      await expect(cancelRunService(actor, run1.id)).rejects.toThrow(
        /at least one active run/i,
      );
      expect(
        await db.run.findUniqueOrThrow({ where: { id: run1.id } }),
      ).toMatchObject({ status: "IN_PROGRESS" });
    } finally {
      await db.auditEvent.deleteMany({
        where: {
          organizationId: { in: [organization.id, foreignOrganization.id] },
        },
      });
      await db.experiment.deleteMany({
        where: { organizationId: organization.id },
      });
      await db.process.deleteMany({
        where: { organizationId: organization.id },
      });
      await db.user.deleteMany({
        where: {
          organizationId: { in: [organization.id, foreignOrganization.id] },
        },
      });
      await db.organization.deleteMany({
        where: { id: { in: [organization.id, foreignOrganization.id] } },
      });
    }
  });
});
