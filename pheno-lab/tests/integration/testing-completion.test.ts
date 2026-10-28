import { afterAll, afterEach, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { db } from "@/infrastructure/db/client";
import {
  getTestingExperiment,
  listTestingExperiments,
} from "@/modules/testing/query";
import {
  saveCharacterizationResultService,
  regroupSampleService,
} from "@/modules/runs/service";
import * as audit from "@/modules/audit/writer";
import { refreshSampleJvResult } from "@/modules/instruments/matching-service";
import { requestTesting } from "@/modules/testing/service";
import { objectStorage } from "@/infrastructure/storage";
import { applyTestPlan } from "@/modules/experiments/plan-service";
import { ingestInstrumentUpload } from "@/modules/instruments/ingest-service";
import {
  setTestingStatus,
  TestingStatusConflict,
} from "@/modules/testing/status-service";
import { AuthorizationError } from "@/modules/authorization/policy";

vi.mock("@/modules/notifications/group-service", () => ({
  sendGroupNotice: vi.fn().mockResolvedValue(false),
}));

afterAll(() => db.$disconnect());
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const suffix = crypto.randomUUID();
  const organization = await db.organization.create({
    data: { name: "Completion fixture", slug: `completion-${suffix}` },
  });
  const user = await db.user.create({
    data: {
      organizationId: organization.id,
      name: "Preparation colleague",
      email: `completion-${suffix}@example.test`,
      passwordHash: "fixture-only",
      role: "MANAGER",
    },
  });
  const tester = await db.user.create({
    data: {
      organizationId: organization.id,
      name: "Read-only tester",
      email: `completion-reader-${suffix}@example.test`,
      passwordHash: "fixture-only",
      role: "TECHNICIAN",
      testingOnly: true,
    },
  });
  const process = await db.process.create({
    data: {
      organizationId: organization.id,
      name: "J-V",
      kind: "CHARACTERIZATION",
    },
  });
  const experiment = await db.experiment.create({
    data: {
      organizationId: organization.id,
      createdById: user.id,
      code: `COMPLETION-${suffix}`,
      title: "PRIVATE preparation",
      status: "IN_LAB",
      metadata: {
        testPlan: {
          groups: [
            { label: "A", samples: 1 },
            { label: "B", samples: 1 },
          ],
          substrates: { count: 4 },
        },
      },
      samples: {
        create: [
          {
            code: "S1",
            variationGroup: "A",
            instrumentCodes: [`FIXTURE-${suffix}-S1`],
          },
          {
            code: "S2",
            variationGroup: "B",
            instrumentCodes: [`FIXTURE-${suffix}-S2`],
          },
          { code: "S3", variationGroup: "ERROR" },
          { code: "S4" },
        ],
      },
      runs: { create: [{ runNo: 1 }, { runNo: 2 }] },
      characterizations: {
        create: [
          { processId: process.id, position: 0, name: "J-V" },
          { processId: process.id, position: 1, name: "Other J-V card" },
        ],
      },
    },
    include: {
      samples: { orderBy: { code: "asc" } },
      runs: { orderBy: { runNo: "asc" } },
      characterizations: { orderBy: { position: "asc" } },
    },
  });
  const actor = {
    uid: user.id,
    org: organization.id,
    role: "MANAGER" as const,
  };
  const reader = {
    uid: tester.id,
    org: organization.id,
    role: "TECHNICIAN" as const,
    testingOnly: true,
  };
  const request = (runIndex = 0, cardIndex = 0) =>
    db.testingRequest.create({
      data: {
        organizationId: organization.id,
        experimentId: experiment.id,
        runId: experiment.runs[runIndex].id,
        characterizationId: experiment.characterizations[cardIndex].id,
        requestedById: user.id,
        sampleIds: [experiment.samples[0].id],
        photoPath: "fixture-only.png",
        requestKey: crypto.randomUUID(),
      },
    });
  const save = (
    sampleIndex: number,
    runIndex = 0,
    cardIndex = 0,
    metrics = { "PCE (%)": "20" },
  ) =>
    saveCharacterizationResultService(actor, {
      sampleId: experiment.samples[sampleIndex].id,
      runId: experiment.runs[runIndex].id,
      characterizationId: experiment.characterizations[cardIndex].id,
      metrics,
      note: "",
    });
  const complete = async () =>
    (await getTestingExperiment(reader, experiment.id))?.complete;
  const cleanup = async () => {
    await db.auditEvent.deleteMany({
      where: { organizationId: organization.id },
    });
    await db.experiment.deleteMany({
      where: { organizationId: organization.id },
    });
    await db.instrument.deleteMany({
      where: { organizationId: organization.id },
    });
    await db.process.deleteMany({ where: { organizationId: organization.id } });
    await db.label.deleteMany({ where: { organizationId: organization.id } });
    await db.user.deleteMany({ where: { organizationId: organization.id } });
    await db.organization.delete({ where: { id: organization.id } });
  };
  return {
    organization,
    user,
    tester,
    process,
    experiment,
    actor,
    reader,
    request,
    save,
    complete,
    cleanup,
  };
}

async function correction(
  f: Awaited<ReturnType<typeof fixture>>,
  status: "COMPLETE" | "IN_PROGRESS" | "AUTO",
) {
  const detail = await getTestingExperiment(f.reader, f.experiment.id);
  return {
    experimentId: f.experiment.id,
    requestSetKey: detail!.requestSetKey,
    status,
    reason: "  Confirmed at the instrument  ",
  };
}

it("lets only the testing specialist correct unified status without changing scientific data, with an atomic audit and one completion notice", async () => {
  const f = await fixture();
  try {
    const request = await f.request();
    const before = await db.experiment.findUniqueOrThrow({
      where: { id: f.experiment.id },
    });
    const input = await correction(f, "COMPLETE");
    await setTestingStatus(f.reader, input);
    const detail = await getTestingExperiment(f.reader, f.experiment.id);
    expect(detail).toMatchObject({
      complete: true,
      automaticComplete: false,
      canSetStatus: true,
      manual: { status: "COMPLETE", reason: "Confirmed at the instrument" },
    });
    expect(detail!.requests.find((r) => r.id === request.id)?.complete).toBe(
      false,
    );
    const list = await listTestingExperiments(f.reader, {});
    expect(list.canSetStatus).toBe(true);
    expect(list.recentRequests[0]).toMatchObject({
      complete: true,
      automaticComplete: false,
      manual: { status: "COMPLETE" },
    });
    expect(list.rows[0]).toMatchObject({
      complete: true,
      manual: { status: "COMPLETE" },
    });
    expect(
      (await getTestingExperiment(f.actor, f.experiment.id))?.canSetStatus,
    ).toBe(false);
    expect(
      await db.experiment.findUniqueOrThrow({ where: { id: f.experiment.id } }),
    ).toEqual(before);
    expect(
      await db.characterizationResult.count({
        where: { characterization: { experimentId: f.experiment.id } },
      }),
    ).toBe(0);
    const auditRow = await db.auditEvent.findFirstOrThrow({
      where: {
        organizationId: f.organization.id,
        action: "testing.status_set",
      },
    });
    expect(auditRow).toMatchObject({
      actorType: "USER",
      actorUserId: f.tester.id,
      entityId: f.experiment.id,
      metadata: {
        requestSetKey: input.requestSetKey,
        reason: "Confirmed at the instrument",
      },
    });
    expect(
      await db.notification.count({
        where: { organizationId: f.organization.id, kind: "testing_completed" },
      }),
    ).toBe(1);
    await setTestingStatus(f.reader, input);
    await setTestingStatus(f.reader, { ...input, status: "IN_PROGRESS" });
    await setTestingStatus(f.reader, input);
    expect(
      await db.notification.count({
        where: { organizationId: f.organization.id, kind: "testing_completed" },
      }),
    ).toBe(1);
  } finally {
    await f.cleanup();
  }
});

it("retains a manual in-progress status while results change and restores current automatic status explicitly", async () => {
  const f = await fixture();
  try {
    await f.request();
    await setTestingStatus(f.reader, await correction(f, "IN_PROGRESS"));
    await f.save(0);
    await f.save(1);
    expect(await getTestingExperiment(f.reader, f.experiment.id)).toMatchObject(
      {
        complete: false,
        automaticComplete: true,
        manual: { status: "IN_PROGRESS" },
      },
    );
    expect(
      await db.notification.count({
        where: { organizationId: f.organization.id, kind: "testing_completed" },
      }),
    ).toBe(0);
    await setTestingStatus(f.reader, await correction(f, "AUTO"));
    expect(await getTestingExperiment(f.reader, f.experiment.id)).toMatchObject(
      { complete: true, automaticComplete: true, manual: null },
    );
    expect(
      await db.testingStatusOverride.count({
        where: { experimentId: f.experiment.id },
      }),
    ).toBe(0);
    expect(
      await db.notification.count({
        where: { organizationId: f.organization.id, kind: "testing_completed" },
      }),
    ).toBe(1);
  } finally {
    await f.cleanup();
  }
});

it("invalidates manual status on a new handoff and rejects a stale browser without changing the new batch", async () => {
  const f = await fixture();
  try {
    await f.request();
    const old = await correction(f, "COMPLETE");
    await setTestingStatus(f.reader, old);
    await f.request(1);
    const current = await getTestingExperiment(f.reader, f.experiment.id);
    expect(current).toMatchObject({ complete: false, manual: null });
    expect(current!.requestSetKey).not.toBe(old.requestSetKey);
    await expect(setTestingStatus(f.reader, old)).rejects.toBeInstanceOf(
      TestingStatusConflict,
    );
    expect(
      await db.auditEvent.count({
        where: {
          organizationId: f.organization.id,
          action: "testing.status_set",
        },
      }),
    ).toBe(1);
    await setTestingStatus(f.reader, await correction(f, "COMPLETE"));
    expect(
      await db.notification.count({
        where: { organizationId: f.organization.id, kind: "testing_completed" },
      }),
    ).toBe(2);
  } finally {
    await f.cleanup();
  }
});

it("rejects ordinary colleagues, staff, forged grants and freshly revoked or restricted testing accounts", async () => {
  const f = await fixture();
  try {
    await f.request();
    const input = await correction(f, "COMPLETE");
    for (const role of ["TECHNICIAN", "MANAGER", "ADMIN"] as const) {
      await db.user.update({ where: { id: f.user.id }, data: { role } });
      await expect(
        setTestingStatus({ ...f.actor, role, testingOnly: true }, input),
      ).rejects.toBeInstanceOf(AuthorizationError);
    }
    for (const restriction of [
      { active: false },
      { pendingApproval: true },
      { mustChangePassword: true },
      { testingOnly: false },
    ]) {
      await db.user.update({ where: { id: f.tester.id }, data: restriction });
      await expect(setTestingStatus(f.reader, input)).rejects.toBeInstanceOf(
        AuthorizationError,
      );
      await db.user.update({
        where: { id: f.tester.id },
        data: {
          active: true,
          pendingApproval: false,
          mustChangePassword: false,
          testingOnly: true,
        },
      });
    }
    await db.organization.update({
      where: { id: f.organization.id },
      data: { status: "PENDING" },
    });
    await expect(setTestingStatus(f.reader, input)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await db.organization.update({
      where: { id: f.organization.id },
      data: { status: "ACTIVE" },
    });
    expect(
      await db.testingStatusOverride.count({
        where: { experimentId: f.experiment.id },
      }),
    ).toBe(0);
    expect(
      await db.auditEvent.count({
        where: {
          action: "testing.status_set",
          organizationId: f.organization.id,
        },
      }),
    ).toBe(0);
  } finally {
    await f.cleanup();
  }
});

it("rejects another organization's actor and test, deleted or unsubmitted experiments", async () => {
  const f = await fixture();
  const foreign = await fixture();
  try {
    await f.request();
    const input = await correction(f, "COMPLETE");
    await expect(
      setTestingStatus(foreign.reader, input),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      setTestingStatus({ ...f.reader, org: foreign.organization.id }, input),
    ).rejects.toBeInstanceOf(AuthorizationError);
    for (const data of [{ isTest: true }, { deletedAt: new Date() }]) {
      await db.experiment.update({ where: { id: f.experiment.id }, data });
      await expect(setTestingStatus(f.reader, input)).rejects.toBeInstanceOf(
        AuthorizationError,
      );
      await db.experiment.update({
        where: { id: f.experiment.id },
        data: { isTest: false, deletedAt: null },
      });
    }
    await expect(
      setTestingStatus(foreign.reader, {
        ...input,
        experimentId: foreign.experiment.id,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(
      await db.testingStatusOverride.count({
        where: {
          organizationId: { in: [f.organization.id, foreign.organization.id] },
        },
      }),
    ).toBe(0);
  } finally {
    await f.cleanup();
    await foreign.cleanup();
  }
});

it("rolls back the override and audit if completion delivery fails", async () => {
  const f = await fixture();
  try {
    await f.request();
    const original = audit.recordSystemAudit;
    vi.spyOn(audit, "recordSystemAudit").mockImplementation(
      async (tx, input) => {
        if (input.action === "testing.completed")
          throw new Error("synthetic receipt failure");
        return original(tx, input);
      },
    );
    await expect(
      setTestingStatus(f.reader, await correction(f, "COMPLETE")),
    ).rejects.toThrow("synthetic receipt failure");
    expect(await f.complete()).toBe(false);
    expect(
      await db.testingStatusOverride.count({
        where: { experimentId: f.experiment.id },
      }),
    ).toBe(0);
    expect(
      await db.auditEvent.count({
        where: { organizationId: f.organization.id },
      }),
    ).toBe(0);
    expect(
      await db.notification.count({
        where: { organizationId: f.organization.id, kind: "testing_completed" },
      }),
    ).toBe(0);
  } finally {
    await f.cleanup();
  }
});

it("serializes simultaneous manual completions and result saves without duplicating delivery", async () => {
  const f = await fixture();
  try {
    await f.request();
    const input = await correction(f, "COMPLETE");
    await Promise.all([
      setTestingStatus(f.reader, input),
      setTestingStatus(f.reader, input),
      f.save(0),
      f.save(1),
    ]);
    expect(await f.complete()).toBe(true);
    expect(
      await db.testingStatusOverride.count({
        where: { experimentId: f.experiment.id },
      }),
    ).toBe(1);
    expect(
      await db.notification.count({
        where: { organizationId: f.organization.id, kind: "testing_completed" },
      }),
    ).toBe(1);
    expect(
      await db.auditEvent.count({
        where: {
          organizationId: f.organization.id,
          action: "testing.completed",
        },
      }),
    ).toBe(1);
  } finally {
    await f.cleanup();
  }
});

it("matches list/detail status to all allocated groups, not just the selected handoff substrates", async () => {
  const f = await fixture();
  try {
    await f.request();
    expect(await f.complete()).toBe(false);
    await f.save(0);
    expect(await f.complete()).toBe(false);
    await f.save(1);
    expect(await f.complete()).toBe(true);
    const list = await listTestingExperiments(f.reader, {});
    expect(list.rows[0].complete).toBe(true);
    expect(list.recentRequests[0].complete).toBe(true);
    expect(JSON.stringify(list)).not.toMatch(
      /PRIVATE|PCE|variationGroup|sourceMeasurementId/,
    );
    await f.save(1, 0, 0, { "PCE (%)": "" });
    expect(await f.complete()).toBe(false);
  } finally {
    await f.cleanup();
  }
});

it("ignores stale instrument results and records a manual replacement as manual", async () => {
  const f = await fixture();
  try {
    await f.request();
    await f.save(0);
    const instrument = await db.instrument.create({
      data: {
        organizationId: f.organization.id,
        name: "Synthetic JV instrument",
        kind: "GIANTFORCE_IV",
        apiKeyHash: crypto.randomUUID(),
      },
    });
    const upload = await db.instrumentUpload.create({
      data: {
        instrumentId: instrument.id,
        fileName: "fixture.csv",
        storedPath: "fixture-only.csv",
        sha256: "fixture-only",
        size: 1,
        status: "PARSED",
      },
    });
    const scan = await db.jvMeasurement.create({
      data: {
        organizationId: f.organization.id,
        instrumentId: instrument.id,
        uploadId: upload.id,
        serial: "fixture",
        serialKey: "fixture",
        scanKey: "fixture",
        status: "MATCHED",
        experimentId: f.experiment.id,
        sampleId: f.experiment.samples[1].id,
        runId: f.experiment.runs[0].id,
        metrics: { pce: 21 },
        curve: [],
        matchNote: "",
      },
    });
    expect(await refreshSampleJvResult(f.experiment.samples[1].id)).toBe(
      "written",
    );
    expect(await f.complete()).toBe(true);
    expect(
      await db.notification.count({
        where: { organizationId: f.organization.id, kind: "testing_completed" },
      }),
    ).toBe(1);
    await refreshSampleJvResult(f.experiment.samples[1].id);
    expect(
      await db.notification.count({
        where: { organizationId: f.organization.id, kind: "testing_completed" },
      }),
    ).toBe(1);
    await db.jvMeasurement.update({
      where: { id: scan.id },
      data: { status: "IGNORED" },
    });
    expect(await f.complete()).toBe(false);
    expect(await f.save(1)).toMatchObject({
      source: "MANUAL",
      sourceMeasurementId: null,
    });
    expect(await f.complete()).toBe(true);
  } finally {
    await f.cleanup();
  }
});

it("separates runs and characterization cards and requires every submitted scope", async () => {
  const f = await fixture();
  try {
    await f.request(1);
    await f.save(0);
    await f.save(1);
    await f.save(0, 1);
    await f.save(1, 1, 1);
    expect(await f.complete()).toBe(false);
    await f.save(1, 1);
    expect(await f.complete()).toBe(true);
    await f.request(0, 1);
    expect(await f.complete()).toBe(false);
    await f.save(0, 0, 1);
    await f.save(1, 0, 1);
    expect(await f.complete()).toBe(true);
    await db.run.update({
      where: { id: f.experiment.runs[0].id },
      data: { status: "CANCELLED" },
    });
    expect(await f.complete()).toBe(false);
  } finally {
    await f.cleanup();
  }
});

it("recomputes after regrouping and never completes a scope containing only ERROR/spares", async () => {
  const f = await fixture();
  try {
    await f.request();
    await f.save(0);
    await regroupSampleService(
      f.actor,
      f.experiment.samples[1].id,
      "ERROR",
      "Fixture scrap",
    );
    expect(await f.complete()).toBe(true);
    expect(
      await db.notification.count({
        where: { organizationId: f.organization.id, kind: "testing_completed" },
      }),
    ).toBe(1);
    await regroupSampleService(f.actor, f.experiment.samples[3].id, "B");
    expect(await f.complete()).toBe(false);
    await f.save(3);
    expect(await f.complete()).toBe(true);
    await regroupSampleService(f.actor, f.experiment.samples[0].id, "EXTRA");
    await regroupSampleService(f.actor, f.experiment.samples[3].id, "EXTRA");
    expect(await f.complete()).toBe(false);
  } finally {
    await f.cleanup();
  }
});

it("notifies current creator/assignee/members once under concurrent saves, excluding foreign and restricted accounts", async () => {
  const f = await fixture();
  const foreign = await db.organization.create({
    data: {
      name: "Foreign completion fixture",
      slug: `foreign-completion-${crypto.randomUUID()}`,
    },
  });
  try {
    const member = (name: string, extra = {}) =>
      db.user.create({
        data: {
          organizationId: f.organization.id,
          name,
          email: `completion-${name}-${crypto.randomUUID()}@example.test`,
          passwordHash: "fixture-only",
          role: "TECHNICIAN",
          ...extra,
        },
      });
    const former = await member("former");
    const current = await member("current");
    const colleague = await member("member");
    const inactive = await member("inactive", { active: false });
    const pending = await member("pending", { pendingApproval: true });
    const setup = await member("setup", { mustChangePassword: true });
    const outsider = await member("foreign", { organizationId: foreign.id });
    await db.experiment.update({
      where: { id: f.experiment.id },
      data: {
        assigneeId: former.id,
        members: {
          create: [
            f.user.id,
            colleague.id,
            inactive.id,
            pending.id,
            setup.id,
            f.tester.id,
            outsider.id,
          ].map((userId) => ({ userId })),
        },
      },
    });
    const request = await f.request();
    await db.testingRequest.update({
      where: { id: request.id },
      data: { requestedById: former.id },
    });
    await db.experiment.update({
      where: { id: f.experiment.id },
      data: { assigneeId: current.id },
    });
    await Promise.all([f.save(0), f.save(1)]);
    const notifications = () =>
      db.notification.findMany({
        where: { organizationId: f.organization.id, kind: "testing_completed" },
        orderBy: { userId: "asc" },
      });
    const rows = await notifications();
    expect(rows.map((n) => n.userId).sort()).toEqual(
      [f.user.id, current.id, colleague.id].sort(),
    );
    expect(
      rows.every(
        (n) =>
          n.actorName === "" &&
          n.href === `/experiments/${f.experiment.id}/results` &&
          n.entityLabel === f.experiment.code,
      ),
    ).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("PRIVATE");
    await Promise.all([f.save(0), f.save(1), f.save(1)]);
    await f.complete();
    await listTestingExperiments(f.reader, {});
    expect(await notifications()).toEqual(rows);
    expect(
      await db.auditEvent.count({
        where: {
          organizationId: f.organization.id,
          action: "testing.completed",
        },
      }),
    ).toBe(1);
    await f.request();
    await f.save(1);
    expect(await notifications()).toHaveLength(6);
    expect(
      await db.auditEvent.count({
        where: {
          organizationId: f.organization.id,
          action: "testing.completed",
        },
      }),
    ).toBe(2);
  } finally {
    await f.cleanup();
    await db.user.deleteMany({ where: { organizationId: foreign.id } });
    await db.organization.delete({ where: { id: foreign.id } });
  }
});

it("rolls back the final result, notifications and receipt together, then permits a clean retry", async () => {
  const f = await fixture();
  try {
    await f.request();
    await f.save(0);
    const spy = vi
      .spyOn(audit, "recordSystemAudit")
      .mockRejectedValueOnce(new Error("Synthetic completion receipt failure"));
    await expect(f.save(1)).rejects.toThrow(
      "Synthetic completion receipt failure",
    );
    spy.mockRestore();
    expect(
      await db.characterizationResult.count({
        where: { sampleId: f.experiment.samples[1].id },
      }),
    ).toBe(0);
    expect(
      await db.notification.count({
        where: { organizationId: f.organization.id, kind: "testing_completed" },
      }),
    ).toBe(0);
    expect(
      await db.auditEvent.count({
        where: {
          organizationId: f.organization.id,
          action: "testing.completed",
        },
      }),
    ).toBe(0);
    await f.save(1);
    expect(await f.complete()).toBe(true);
    expect(
      await db.notification.count({
        where: { organizationId: f.organization.id, kind: "testing_completed" },
      }),
    ).toBe(1);
  } finally {
    await f.cleanup();
  }
});

it("notifies when an applied plan moves the remaining untested substrate to Extras", async () => {
  const f = await fixture();
  try {
    await f.request();
    await f.save(0);
    await applyTestPlan(f.actor, f.experiment.id, {
      substrates: { count: 4 },
      groups: [
        { label: "A", samples: 1, isControl: true },
        { label: "B", samples: 0, isControl: false },
      ],
      variables: [],
      assignments: { S1: "A", S2: "EXTRA", S3: "ERROR", S4: "EXTRA" },
    });
    expect(await f.complete()).toBe(true);
    expect(
      await db.notification.count({
        where: { organizationId: f.organization.id, kind: "testing_completed" },
      }),
    ).toBe(1);
  } finally {
    await f.cleanup();
  }
});

it("delivers immediately for an already-completed handoff and keeps its retry idempotent", async () => {
  const f = await fixture();
  const photoPath = `organizations/${f.organization.id}/users/${f.user.id}/images/completion-fixture.png`;
  try {
    await f.save(0);
    await f.save(1);
    expect(
      await db.notification.count({
        where: { organizationId: f.organization.id, kind: "testing_completed" },
      }),
    ).toBe(0);
    await objectStorage().put({
      key: photoPath,
      body: new Uint8Array([137, 80, 78, 71]),
      contentType: "image/png",
    });
    const input = {
      runId: f.experiment.runs[0].id,
      characterizationId: f.experiment.characterizations[0].id,
      sampleIds: [f.experiment.samples[0].id],
      photoPath,
      note: "",
      requestKey: crypto.randomUUID(),
    };
    expect((await requestTesting(f.actor, input)).created).toBe(true);
    expect((await requestTesting(f.actor, input)).created).toBe(false);
    expect(
      await db.notification.count({
        where: { organizationId: f.organization.id, kind: "testing_completed" },
      }),
    ).toBe(1);
  } finally {
    await objectStorage().delete(photoPath);
    await f.cleanup();
  }
});

it("recovers an interrupted result/notification transaction on the instrument's unchanged duplicate-upload contract", async () => {
  const f = await fixture();
  try {
    await f.request(1);
    await f.save(0, 1);
    await db.sample.update({
      where: { id: f.experiment.samples[1].id },
      data: { instrumentCodes: ["C1-1"] },
    });
    const instrument = await db.instrument.create({
      data: {
        organizationId: f.organization.id,
        name: "Retry fixture instrument",
        kind: "GIANTFORCE_IV",
        apiKeyHash: crypto.randomUUID(),
      },
    });
    const body = await readFile(
      "src/lib/instruments/__fixtures__/giantforce-auto-single.csv",
    );
    const input = {
      body,
      fileName: "synthetic-retry.csv",
      sourcePath: "fixture.csv",
      sourceDir: "fixture",
      modifiedAt: null,
      mime: "text/csv",
    };
    const original = audit.recordSystemAudit;
    const spy = vi
      .spyOn(audit, "recordSystemAudit")
      .mockImplementation(async (tx, event) => {
        if (event.action === "testing.completed")
          throw new Error("Synthetic interrupted completion");
        return original(tx, event);
      });
    await expect(ingestInstrumentUpload(instrument, input)).rejects.toThrow(
      "Synthetic interrupted completion",
    );
    spy.mockRestore();
    expect(
      await db.instrumentUpload.count({
        where: { instrumentId: instrument.id },
      }),
    ).toBe(1);
    expect(
      await db.jvMeasurement.count({ where: { instrumentId: instrument.id } }),
    ).toBe(1);
    expect(
      await db.characterizationResult.count({
        where: { sampleId: f.experiment.samples[1].id },
      }),
    ).toBe(0);
    expect(
      await db.notification.count({
        where: { organizationId: f.organization.id, kind: "testing_completed" },
      }),
    ).toBe(0);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await ingestInstrumentUpload(instrument, input)).toEqual({
        statusCode: 409,
        body: {
          status: "duplicate",
          message: "Already received this file",
          scans: 0,
        },
      });
    }
    expect(await f.complete()).toBe(true);
    expect(
      await db.notification.count({
        where: { organizationId: f.organization.id, kind: "testing_completed" },
      }),
    ).toBe(1);
    expect(
      await db.auditEvent.count({
        where: {
          organizationId: f.organization.id,
          action: "testing.completed",
        },
      }),
    ).toBe(1);
  } finally {
    const uploads = await db.instrumentUpload.findMany({
      where: { instrument: { organizationId: f.organization.id } },
      select: { storedPath: true },
    });
    for (const upload of uploads)
      await objectStorage().delete(upload.storedPath);
    await f.cleanup();
  }
});

it("does not mark an unsent experiment complete or expose status outside the reader's scope", async () => {
  const f = await fixture();
  try {
    await f.save(0);
    await f.save(1);
    expect(await f.complete()).toBe(false);
    await f.request();
    const outsider = await db.user.create({
      data: {
        organizationId: f.organization.id,
        name: "Uninvolved",
        email: `uninvolved-${crypto.randomUUID()}@example.test`,
        passwordHash: "fixture-only",
      },
    });
    const actor = {
      uid: outsider.id,
      org: f.organization.id,
      role: "TECHNICIAN" as const,
    };
    expect(await getTestingExperiment(actor, f.experiment.id)).toBeNull();
    expect((await listTestingExperiments(actor, {})).rows).toEqual([]);
    await expect(
      saveCharacterizationResultService(actor, {
        sampleId: f.experiment.samples[0].id,
        runId: f.experiment.runs[0].id,
        characterizationId: f.experiment.characterizations[0].id,
        metrics: { pce: "30" },
        note: "",
      }),
    ).rejects.toThrow();
    await expect(f.save(0)).resolves.toBeTruthy();
    expect(await f.complete()).toBe(true);
  } finally {
    await f.cleanup();
  }
});
