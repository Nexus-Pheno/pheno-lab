import { readFile } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/infrastructure/db/client";
import type { Actor } from "@/modules/authorization/actor";
import {
  createExperiment,
  duplicateExperiment,
  updateExperimentMeta,
} from "@/modules/experiments/lifecycle-service";
import { applyTestPlan } from "@/modules/experiments/plan-service";
import { regroupSampleService } from "@/modules/runs/service";
import { setSamples } from "@/modules/experiments/membership-service";
import { deleteExperiment } from "@/modules/experiments/lifecycle-service";
import {
  purgeExperiment,
  restoreExperiment,
} from "@/modules/experiments/trash-service";
import { assignExperiment } from "@/modules/workflow/service";
import {
  syncSampleSerials,
  reserveInstrumentCodes,
} from "@/modules/instruments/sample-serial-engine";
import { matchSerial } from "@/modules/instruments/matching-service";
import { setSampleAliases } from "@/modules/instruments/measurement-service";

const organizations: string[] = [];
afterAll(async () => {
  for (const organizationId of organizations) {
    await db.auditEvent.deleteMany({ where: { organizationId } });
    await db.notification.deleteMany({ where: { organizationId } });
    await db.instrument.deleteMany({ where: { organizationId } });
    await db.experiment.deleteMany({ where: { organizationId } });
    await db.process.deleteMany({ where: { organizationId } });
    await db.label.deleteMany({ where: { organizationId } });
    await db.user.deleteMany({ where: { organizationId } });
    await db.organization.delete({ where: { id: organizationId } });
  }
  await db.$disconnect();
});

async function fixture(userNumber = 23) {
  const suffix = crypto.randomUUID();
  const maxOrgNumber =
    (await db.organization.aggregate({ _max: { orgNumber: true } }))._max
      .orgNumber ?? 0;
  const org = await db.organization.create({
    data: {
      name: "Sample identity test",
      slug: `sample-identity-${suffix}`,
      orgNumber: Math.max(5000, maxOrgNumber) + 1,
    },
  });
  organizations.push(org.id);
  const user = await db.user.create({
    data: {
      organizationId: org.id,
      email: `identity-${suffix}@example.test`,
      name: "Original issuer",
      role: "ADMIN",
      userNumber,
      passwordHash: "test-only",
    },
  });
  const actor: Actor = { org: org.id, uid: user.id, role: "ADMIN" };
  const exp = await createExperiment(actor);
  const samples = () =>
    db.sample.findMany({
      where: { experimentId: exp.id },
      orderBy: { code: "asc" },
    });
  return { org, actor, exp, samples };
}

const plan = (count = 4) => ({
  substrates: { count, materialName: "Test substrate" },
  groups: [{ label: "A", samples: count, isControl: true }],
  variables: [],
  assignments: Object.fromEntries(
    Array.from({ length: count }, (_, i) => [
      `S${i + 1}`,
      i === 1 ? "EXTRA" : "A",
    ]),
  ),
});

describe("permanent sample identities against PostgreSQL", () => {
  it("keeps codes, QR IDs, aliases and late-upload matching through reassignment and completion", async () => {
    const f = await fixture();
    const before = await f.samples();
    const next = await db.user.create({
      data: {
        organizationId: f.org.id,
        email: `next-${crypto.randomUUID()}@example.test`,
        name: "New technician",
        role: "TECHNICIAN",
        userNumber: 24,
        passwordHash: "test-only",
      },
    });
    await assignExperiment(f.actor, {
      experimentId: f.exp.id,
      userId: next.id,
    });
    expect(await f.samples()).toEqual(before);
    await updateExperimentMeta(f.actor, f.exp.id, { status: "COMPLETE" });
    await db.$transaction((tx) => syncSampleSerials(tx, f.exp.id));
    expect(await f.samples()).toEqual(before);
    expect(await matchSerial(f.org.id, `${before[0].simCode}-2`)).toMatchObject(
      { status: "MATCHED", sampleId: before[0].id },
    );
    await setSampleAliases(f.actor, { sampleId: before[0].id, aliases: [] });
    expect((await f.samples())[0].instrumentCodes).toContain(before[0].simCode);
  });

  it("preserves captures, manual results, scans, notes and QR IDs during grouping and plan edits", async () => {
    const f = await fixture();
    const before = await f.samples();
    const process = await db.process.create({
      data: {
        organizationId: f.org.id,
        name: "Identity process",
        kind: "PROCESSING",
      },
    });
    const step = await db.processStep.create({
      data: {
        experimentId: f.exp.id,
        processId: process.id,
        name: "Captured step",
        position: 0,
      },
    });
    const char = await db.characterization.create({
      data: {
        experimentId: f.exp.id,
        name: "Manual test",
        processId: process.id,
        position: 0,
      },
    });
    const run = await db.run.create({
      data: { experimentId: f.exp.id, runNo: 1 },
    });
    const capture = await db.stepExecution.create({
      data: {
        runId: run.id,
        stepId: step.id,
        sampleId: before[0].id,
        actuals: {},
        note: "Keep this capture",
      },
    });
    const result = await db.characterizationResult.create({
      data: {
        characterizationId: char.id,
        sampleId: before[0].id,
        runId: run.id,
        metrics: { "PCE (%)": "24.0" },
        note: "Manual result",
      },
    });
    const instrument = await db.instrument.create({
      data: {
        organizationId: f.org.id,
        name: "Identity rig",
        kind: "GIANTFORCE_IV",
        apiKeyHash: crypto.randomUUID(),
      },
    });
    const upload = await db.instrumentUpload.create({
      data: {
        instrumentId: instrument.id,
        sha256: crypto.randomUUID(),
        fileName: "test.csv",
        storedPath: "test-only",
        size: 1,
        status: "PARSED",
      },
    });
    const scan = await db.jvMeasurement.create({
      data: {
        organizationId: f.org.id,
        instrumentId: instrument.id,
        uploadId: upload.id,
        scanKey: crypto.randomUUID(),
        serial: before[0].simCode!,
        serialKey: before[0].simCode!,
        metrics: {},
        curve: [],
        status: "MATCHED",
        sampleId: before[0].id,
        experimentId: f.exp.id,
      },
    });
    await db.sample.update({
      where: { id: before[0].id },
      data: { note: "Physical sample note" },
    });
    await applyTestPlan(f.actor, f.exp.id, plan());
    const after = await f.samples();
    expect(after.map((s) => [s.id, s.simCode, s.instrumentCodes])).toEqual(
      before.map((s) => [s.id, s.simCode, s.instrumentCodes]),
    );
    expect(after[0].note).toBe("Physical sample note");
    expect(
      await db.stepExecution.findUnique({ where: { id: capture.id } }),
    ).toEqual(capture);
    expect(
      await db.characterizationResult.findUnique({ where: { id: result.id } }),
    ).toEqual(result);
    expect(
      await db.jvMeasurement.findUnique({ where: { id: scan.id } }),
    ).toEqual(scan);
    expect(
      (await db.experiment.findUniqueOrThrow({ where: { id: f.exp.id } }))
        .metadata,
    ).toMatchObject({
      testPlan: {
        ...plan(),
        groups: [{ label: "A", samples: 3, isControl: true }],
      },
    });
    await setSamples(
      f.actor,
      f.exp.id,
      after.map((s) => ({ code: s.code, variationGroup: "B" })),
    );
    expect((await f.samples()).map((s) => s.id)).toEqual(
      before.map((s) => s.id),
    );
    await expect(applyTestPlan(f.actor, f.exp.id, plan(3))).rejects.toThrow(
      /Cannot remove/,
    );
    expect(
      await db.characterizationResult.findUnique({ where: { id: result.id } }),
    ).toEqual(result);
    expect(await f.samples()).toHaveLength(4);
  });

  it("retains empty group settings and sample evidence through allocation and return to Extras", async () => {
    const f = await fixture();
    const original = await f.samples();
    const process = await db.process.create({
      data: {
        organizationId: f.org.id,
        name: "Empty group process",
        kind: "PROCESSING",
      },
    });
    const emptyGroupsPlan = {
      substrates: { count: 17 },
      groups: ["A", "B", "C", "D", "E"].map((label) => ({
        label,
        samples: 0,
        isControl: label === "A",
      })),
      variables: [
        {
          kind: "parameter",
          processId: process.id,
          parameter: "Speed",
          unit: "rpm",
          values: { A: "1000", B: "1100", C: "1200", D: "1300", E: "1400" },
        },
      ],
      assignments: Object.fromEntries(
        Array.from({ length: 17 }, (_, i) => [`S${i + 1}`, "EXTRA"]),
      ),
    };
    await applyTestPlan(f.actor, f.exp.id, emptyGroupsPlan);
    const samples = await f.samples();
    expect(samples).toHaveLength(17);
    expect(samples.every((sample) => sample.variationGroup === null)).toBe(
      true,
    );
    expect(
      samples
        .filter((sample) => original.some((old) => old.id === sample.id))
        .map((sample) => [sample.id, sample.simCode]),
    ).toEqual(original.map((sample) => [sample.id, sample.simCode]));
    const step = await db.processStep.findFirstOrThrow({
      where: { experimentId: f.exp.id },
    });
    const run = await db.run.create({
      data: { experimentId: f.exp.id, runNo: 1 },
    });
    const capture = await db.stepExecution.create({
      data: {
        runId: run.id,
        stepId: step.id,
        sampleId: samples[0].id,
        actuals: { Speed: "1050" },
        note: "Recorded evidence",
      },
    });
    await regroupSampleService(f.actor, samples[0].id, "B");
    const allocated = await db.experiment.findUniqueOrThrow({
      where: { id: f.exp.id },
    });
    expect(allocated.metadata).toMatchObject({
      testPlan: {
        groups: [
          { label: "A", samples: 0 },
          { label: "B", samples: 1 },
          { label: "C", samples: 0 },
          { label: "D", samples: 0 },
          { label: "E", samples: 0 },
        ],
        assignments: { [samples[0].code]: "B" },
      },
    });
    await regroupSampleService(f.actor, samples[0].id, "EXTRA");
    expect(
      (await db.experiment.findUniqueOrThrow({ where: { id: f.exp.id } }))
        .metadata,
    ).toMatchObject({ testPlan: emptyGroupsPlan });
    expect(
      await db.stepExecution.findUnique({ where: { id: capture.id } }),
    ).toEqual(capture);
    expect(
      (await f.samples()).map((sample) => [sample.id, sample.simCode]),
    ).toEqual(samples.map((sample) => [sample.id, sample.simCode]));
    expect(
      await db.parameterVariation.findMany({
        where: { parameter: { stepId: step.id } },
        orderBy: { variationGroup: "asc" },
        select: { variationGroup: true, value: true },
      }),
    ).toEqual(
      Object.entries(emptyGroupsPlan.variables[0].values).map(
        ([variationGroup, value]) => ({ variationGroup, value }),
      ),
    );
    expect(
      await db.auditEvent.count({
        where: {
          organizationId: f.org.id,
          action: "sample.regroup",
          entityId: samples[0].id,
        },
      }),
    ).toBe(2);
    await Promise.all([
      regroupSampleService(f.actor, samples[0].id, "B"),
      regroupSampleService(f.actor, samples[1].id, "C"),
    ]);
    expect(
      (await db.experiment.findUniqueOrThrow({ where: { id: f.exp.id } }))
        .metadata,
    ).toMatchObject({
      testPlan: {
        assignments: { [samples[0].code]: "B", [samples[1].code]: "C" },
        groups: [
          { label: "A", samples: 0 },
          { label: "B", samples: 1 },
          { label: "C", samples: 1 },
          { label: "D", samples: 0 },
          { label: "E", samples: 0 },
        ],
      },
    });
  });

  it("never reuses prefixes after complete, archive, trash, restore or hard purge", async () => {
    const f = await fixture();
    await updateExperimentMeta(f.actor, f.exp.id, { status: "COMPLETE" });
    const second = await createExperiment(f.actor);
    await updateExperimentMeta(f.actor, second.id, { status: "ARCHIVED" });
    const third = await duplicateExperiment(f.actor, f.exp.id);
    await deleteExperiment(f.actor, third.id);
    await restoreExperiment(f.actor, third.id);
    await deleteExperiment(f.actor, third.id);
    await purgeExperiment(f.actor, third.id);
    const fourth = await createExperiment(f.actor);
    const row = await db.experiment.findUniqueOrThrow({
      where: { id: fourth.id },
    });
    expect(row.simCodePrefix).toBe("23D");
    expect(
      await db.sampleCodeReservation.findUnique({
        where: {
          organizationId_key: { organizationId: f.org.id, key: "PREFIX:23C" },
        },
      }),
    ).not.toBeNull();
  });

  it("serializes concurrent allocations and supports AA, 100+ samples and full employee numbers", async () => {
    const f = await fixture(123);
    await db.$transaction((tx) =>
      reserveInstrumentCodes(
        tx,
        f.org.id,
        Array.from(
          { length: 26 },
          (_, i) => `123${String.fromCharCode(65 + i)}01`,
        ),
      ),
    );
    const [one, two] = await Promise.all([
      createExperiment(f.actor),
      createExperiment(f.actor),
    ]);
    const allocated = await db.experiment.findMany({
      where: { id: { in: [one.id, two.id] } },
      orderBy: { simCodePrefix: "asc" },
    });
    expect(allocated.map((e) => e.simCodePrefix)).toEqual(["123AA", "123AB"]);
    const firstAllocated = allocated[0];
    await applyTestPlan(f.actor, firstAllocated.id, plan(100));
    const sample = await db.sample.findUniqueOrThrow({
      where: {
        experimentId_code: { experimentId: firstAllocated.id, code: "S100" },
      },
    });
    expect(sample.simCode).toBe("123AA100");
    expect(await matchSerial(f.org.id, "123AA100-2")).toMatchObject({
      status: "MATCHED",
      sampleId: sample.id,
    });
    expect(await matchSerial(f.org.id, "23AA100-2")).toMatchObject({
      status: "UNMATCHED",
    });
    const prefix = allocated[0].simCodePrefix;
    await assignExperiment(f.actor, {
      experimentId: firstAllocated.id,
      userId: null,
    });
    expect(
      (
        await db.experiment.findUniqueOrThrow({
          where: { id: firstAllocated.id },
        })
      ).simCodePrefix,
    ).toBe(prefix);
  });

  it("rejects canonical collisions and preserves reservations if a sample row disappears", async () => {
    const f = await fixture();
    const before = await f.samples();
    await expect(
      setSamples(f.actor, f.exp.id, [
        ...before.map((s) => ({ code: s.code, variationGroup: null })),
        { code: "S01", variationGroup: null },
      ]),
    ).rejects.toThrow(/already issued/);
    expect(await f.samples()).toEqual(before);
    await db.sample.delete({ where: { id: before[0].id } }); // simulate legacy deletion in isolated test only
    await expect(
      setSamples(
        f.actor,
        f.exp.id,
        before.map((s) => ({ code: s.code, variationGroup: null })),
      ),
    ).rejects.toThrow(/already issued/);
  });

  it("seeds legacy conflicts without relabeling them, and reserves scans without live samples", async () => {
    const f = await fixture();
    const legacy = await db.experiment.create({
      data: {
        organizationId: f.org.id,
        code: `LEGACY-${crypto.randomUUID()}`,
        title: "Legacy duplicate",
        createdById: f.actor.uid,
        status: "ARCHIVED",
        samples: {
          create: { code: "S1", simCode: "23A01", instrumentCodes: ["23A01"] },
        },
      },
    });
    const instrument = await db.instrument.create({
      data: {
        organizationId: f.org.id,
        name: "Historical rig",
        kind: "GIANTFORCE_IV",
        apiKeyHash: crypto.randomUUID(),
      },
    });
    const upload = await db.instrumentUpload.create({
      data: {
        instrumentId: instrument.id,
        sha256: crypto.randomUUID(),
        fileName: "old.csv",
        storedPath: "test-only",
        size: 1,
        status: "PARSED",
      },
    });
    await db.jvMeasurement.create({
      data: {
        organizationId: f.org.id,
        instrumentId: instrument.id,
        uploadId: upload.id,
        scanKey: crypto.randomUUID(),
        serial: "23B01-1",
        serialKey: "23B01-1",
        metrics: {},
        curve: [],
        status: "UNMATCHED",
      },
    });
    const migration = await readFile(
      "prisma/migrations/20261005000000_permanent_sample_codes/migration.sql",
      "utf8",
    );
    const before = await db.sample.findMany({
      where: { experimentId: legacy.id },
    });
    await db.$executeRawUnsafe(
      migration.slice(migration.indexOf("WITH codes AS")),
    );
    expect(
      await db.sample.findMany({ where: { experimentId: legacy.id } }),
    ).toEqual(before);
    expect(await matchSerial(f.org.id, "23A01")).toMatchObject({
      status: "UNMATCHED",
    });
    const conflictMigration = await readFile(
      "prisma/migrations/20261005010000_historical_sample_code_conflicts/migration.sql",
      "utf8",
    );
    await db.$executeRawUnsafe(
      conflictMigration.slice(conflictMigration.indexOf("WITH claims AS")),
    );
    const oldSample = before[0];
    await db.sample.update({
      where: { id: oldSample.id },
      data: { simCode: "23Z01", instrumentCodes: ["23Z01"] },
    });
    expect(await matchSerial(f.org.id, "23A01")).toMatchObject({
      status: "UNMATCHED",
      matchNote: expect.stringContaining("historical"),
    });
    const next = await createExperiment(f.actor);
    expect(
      (await db.experiment.findUniqueOrThrow({ where: { id: next.id } }))
        .simCodePrefix,
    ).toBe("23C");
  });

  it("serializes concurrent plan and alias edits without losing identities", async () => {
    const f = await fixture();
    const before = await f.samples();
    await Promise.all([
      applyTestPlan(f.actor, f.exp.id, plan()),
      setSampleAliases(f.actor, { sampleId: before[0].id, aliases: [] }),
    ]);
    expect(
      (await f.samples()).map((s) => [s.id, s.simCode, s.instrumentCodes]),
    ).toEqual(before.map((s) => [s.id, s.simCode, s.instrumentCodes]));
  });

  it("keeps identical code namespaces isolated by organization and rejects foreign edits", async () => {
    const a = await fixture();
    const b = await fixture();
    const sa = (await a.samples())[0];
    const sb = (await b.samples())[0];
    expect(sa.simCode).toBe(sb.simCode);
    expect(await matchSerial(a.org.id, sa.simCode!)).toMatchObject({
      sampleId: sa.id,
    });
    expect(await matchSerial(b.org.id, sb.simCode!)).toMatchObject({
      sampleId: sb.id,
    });
    await expect(
      setSamples(a.actor, b.exp.id, [{ code: "S1", variationGroup: null }]),
    ).rejects.toThrow();
    expect(await b.samples()).toHaveLength(4);
  });
});
