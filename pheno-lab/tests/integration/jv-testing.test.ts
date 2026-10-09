import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/infrastructure/db/client";
import { objectStorage } from "@/infrastructure/storage";
import type { Actor } from "@/modules/authorization/actor";
import * as audit from "@/modules/audit/writer";
import {
  provisionTestingAccount,
  revealAccountHandoff,
  getAccountHandoff,
} from "@/modules/accounts/provisioning-service";
import { authenticate } from "@/modules/accounts/auth-service";
import { changePassword } from "@/modules/accounts/profile-service";
import { adminResetPassword } from "@/modules/accounts/registration-service";
import {
  getTestingExperiment,
  listTestingExperiments,
} from "@/modules/testing/query";
import { requestTesting, readTestingPhoto } from "@/modules/testing/service";
import { canReadObject } from "@/modules/files/authorization";
import { sendGroupNotice } from "@/modules/notifications/group-service";

vi.mock("@/modules/notifications/group-service", () => ({
  sendGroupNotice: vi.fn().mockResolvedValue(true),
}));
afterEach(() => vi.restoreAllMocks());
afterAll(() => db.$disconnect());

async function fixture() {
  const suffix = crypto.randomUUID();
  const org = await db.organization.create({
    data: {
      name: "Testing boundary fixture",
      slug: `jv-testing-${suffix}`,
      emailDomains: ["example.test"],
    },
  });
  const member = async (
    name: string,
    role: "ADMIN" | "MANAGER" | "TECHNICIAN",
    extra = {},
  ) =>
    db.user.create({
      data: {
        organizationId: org.id,
        name,
        email: `${name}-${suffix}@example.test`,
        role,
        passwordHash: "test-only",
        ...extra,
      },
    });
  const admin = await member("admin", "ADMIN");
  const delegate = await member("delegate", "MANAGER", { memberAdmin: true });
  const outsider = await member("outsider", "MANAGER");
  const actor = (user: typeof admin): Actor => ({
    uid: user.id,
    org: org.id,
    role: user.role,
    testingOnly: user.testingOnly,
    mustChangePassword: user.mustChangePassword,
  });
  const input = {
    organizationId: org.id,
    name: "Testing specialist",
    email: `specialist-${suffix}@example.test`,
    recipientIds: [admin.id, delegate.id],
    authorizationReference: "Synthetic approved test",
  };
  const provision = await provisionTestingAccount(input);
  const password = await revealAccountHandoff(
    actor(admin),
    provision.handoffId,
  );
  const tester = await db.user.findUniqueOrThrow({
    where: { id: provision.userId },
  });
  const process = await db.process.create({
    data: {
      organizationId: org.id,
      name: "JV testing",
      kind: "CHARACTERIZATION",
    },
  });
  const experiment = await db.experiment.create({
    data: {
      organizationId: org.id,
      createdById: admin.id,
      code: `TESTING-${suffix}`,
      title: "PRIVATE PREPARATION TITLE",
      observation: "PRIVATE OBSERVATION",
      metadata: { secret: "PRIVATE RECIPE" },
      status: "IN_LAB",
      samples: {
        create: [
          { code: "S1", simCode: `SIM-${suffix}`, note: "PRIVATE SAMPLE NOTE" },
          { code: "S2" },
        ],
      },
      characterizations: {
        create: {
          processId: process.id,
          position: 0,
          name: "J-V",
          notes: "Scan forward and reverse",
          settings: { speed: "100 mV/s" },
        },
      },
      runs: { create: { runNo: 1, status: "IN_PROGRESS" } },
    },
    include: { samples: true, characterizations: true, runs: true },
  });
  const photoPath = `organizations/${org.id}/users/${admin.id}/images/test-${suffix}.png`;
  await objectStorage().put({
    key: photoPath,
    body: new Uint8Array([137, 80, 78, 71]),
    contentType: "image/png",
  });
  const request = {
    characterizationId: experiment.characterizations[0].id,
    runId: experiment.runs[0].id,
    sampleIds: [experiment.samples[0].id],
    photoPath,
    note: "Ready for JV",
    requestKey: crypto.randomUUID(),
  };
  return {
    org,
    admin,
    delegate,
    outsider,
    actor,
    input,
    provision,
    password,
    tester,
    experiment,
    request,
    async activate() {
      expect(
        await changePassword(actor(tester), {
          current: password,
          next: "new-testing-password",
        }),
      ).toEqual({ ok: true });
      return { ...actor(tester), mustChangePassword: false };
    },
    async cleanup() {
      await objectStorage().delete(photoPath);
      const where = { organizationId: org.id };
      await db.notification.deleteMany({ where });
      await db.accountHandoff.deleteMany({ where });
      await db.auditEvent.deleteMany({ where });
      await db.experiment.deleteMany({ where });
      await db.instrument.deleteMany({ where });
      await db.process.deleteMany({ where });
      await db.user.deleteMany({ where });
      await db.organization.delete({ where: { id: org.id } });
    },
  };
}

describe("restricted JV accounts on real PostgreSQL", () => {
  it("provisions only once with encrypted credentials and exactly the designated recipients", async () => {
    const f = await fixture();
    try {
      expect(f.tester).toMatchObject({
        role: "TECHNICIAN",
        active: true,
        testingOnly: true,
        mustChangePassword: true,
        memberAdmin: false,
      });
      const handoff = await db.accountHandoff.findUniqueOrThrow({
        where: { id: f.provision.handoffId },
      });
      expect(handoff.encryptedPassword).toMatch(/^enc:v1:/);
      expect(handoff.encryptedPassword).not.toContain(f.password);
      const notifications = await db.notification.findMany({
        where: { organizationId: f.org.id },
      });
      expect(notifications.map((n) => n.userId).sort()).toEqual(
        [f.admin.id, f.delegate.id].sort(),
      );
      expect(JSON.stringify(notifications)).not.toContain(f.password);
      expect(await revealAccountHandoff(f.actor(f.delegate), handoff.id)).toBe(
        f.password,
      );
      await expect(
        revealAccountHandoff(f.actor(f.outsider), handoff.id),
      ).rejects.toThrow();
      await expect(provisionTestingAccount(f.input)).rejects.toThrow(
        "already exists",
      );
      await expect(
        provisionTestingAccount({
          ...f.input,
          email: `second-${f.input.email}`,
          recipientIds: [f.outsider.id],
        }),
      ).rejects.toThrow();
      expect(
        await db.user.count({
          where: { organizationId: f.org.id, testingOnly: true },
        }),
      ).toBe(1);
      expect(
        await authenticate({ email: f.tester.email, password: f.password }),
      ).toMatchObject({
        actor: { testingOnly: true, mustChangePassword: true },
      });
    } finally {
      await f.cleanup();
    }
  });
  it("requires a different password, revokes the handoff, and invalidates previous sessions", async () => {
    const f = await fixture();
    try {
      await expect(
        getTestingExperiment(f.actor(f.tester), f.experiment.id),
      ).rejects.toThrow();
      expect(
        await changePassword(f.actor(f.tester), {
          current: "wrong",
          next: "new-test-password",
        }),
      ).toEqual({ ok: false, error: "wrong-current" });
      expect(
        await changePassword(f.actor(f.tester), {
          current: f.password,
          next: f.password,
        }),
      ).toEqual({ ok: false, error: "same-password" });
      const tester = await f.activate();
      expect(
        await db.user.findUniqueOrThrow({ where: { id: tester.uid } }),
      ).toMatchObject({
        sessionVersion: 1,
        mustChangePassword: false,
        temporaryPasswordExpiresAt: null,
        testingOnly: true,
      });
      expect(
        await db.accountHandoff.findUniqueOrThrow({
          where: { id: f.provision.handoffId },
        }),
      ).toMatchObject({ encryptedPassword: "" });
      expect(
        await getAccountHandoff(f.actor(f.admin), f.provision.handoffId),
      ).toMatchObject({ available: false });
      await expect(
        revealAccountHandoff(f.actor(f.admin), f.provision.handoffId),
      ).rejects.toThrow();
      expect(
        await authenticate({ email: f.tester.email, password: f.password }),
      ).toBeNull();
      expect(
        await authenticate({
          email: f.tester.email,
          password: "new-testing-password",
        }),
      ).toMatchObject({
        actor: { testingOnly: true, mustChangePassword: false },
      });
    } finally {
      await f.cleanup();
    }
  });
  it("shows only testing data across the organization and denies foreign or preparation objects", async () => {
    const f = await fixture();
    const foreign = await fixture();
    try {
      const tester = await f.activate();
      const instrument = await db.instrument.create({
        data: {
          organizationId: f.org.id,
          name: "Synthetic JV instrument",
          kind: "GIANTFORCE_IV",
          apiKeyHash: crypto.randomUUID(),
          uploads: {
            create: {
              fileName: "PRIVATE.csv",
              storedPath: "PRIVATE-RAW-PATH",
              sha256: crypto.randomUUID(),
              size: 100,
              status: "PARSED",
            },
          },
        },
        include: { uploads: true },
      });
      await db.jvMeasurement.createMany({
        data: ["MATCHED", "IGNORED"].map((status) => ({
          organizationId: f.org.id,
          instrumentId: instrument.id,
          uploadId: instrument.uploads[0].id,
          experimentId: f.experiment.id,
          sampleId: f.experiment.samples[0].id,
          serial: "S1",
          serialKey: "s1",
          scanKey: status,
          status,
          direction: "FORWARD",
          condition: "LIGHT",
          metrics: { pce: 20.5, voc: 1.1, privateField: "PRIVATE METADATA" },
          curve: [],
          operator: "PRIVATE OPERATOR",
          material: "PRIVATE MATERIAL",
          settings: { secret: "PRIVATE INSTRUMENT SETTINGS" },
          imagePath: "PRIVATE-IMAGE-PATH",
        })),
      });
      const list = await listTestingExperiments(tester, {});
      expect(list.total).toBe(1);
      expect(list.rows[0].measurements).toBe(1);
      const detail = await getTestingExperiment(tester, f.experiment.id);
      expect(detail?.stages[0].notes).toBe("Scan forward and reverse");
      expect(detail?.measurements).toHaveLength(1);
      expect(detail?.measurements[0].metrics).toEqual({ pce: 20.5, voc: 1.1 });
      expect(JSON.stringify(detail)).not.toMatch(
        /PRIVATE|observation|hypothesis|createdBy|metadata|variationGroup/,
      );
      expect(
        await getTestingExperiment(tester, foreign.experiment.id),
      ).toBeNull();
      expect(await canReadObject(tester, f.request.photoPath)).toBe(false);
      await expect(requestTesting(tester, f.request)).rejects.toThrow();
      await db.user.update({
        where: { id: tester.uid },
        data: { active: false },
      });
      await expect(listTestingExperiments(tester, {})).rejects.toThrow();
    } finally {
      await f.cleanup();
      await foreign.cleanup();
    }
  });
  it("keeps password reset temporary and restricted, including recovery from expiration", async () => {
    const f = await fixture();
    try {
      await db.user.update({
        where: { id: f.tester.id },
        data: { temporaryPasswordExpiresAt: new Date(Date.now() - 1000) },
      });
      await adminResetPassword(
        f.actor(f.admin),
        f.tester.id,
        "recovery-password",
      );
      const user = await db.user.findUniqueOrThrow({
        where: { id: f.tester.id },
      });
      expect(user).toMatchObject({
        testingOnly: true,
        mustChangePassword: true,
        sessionVersion: 1,
      });
      expect(user.temporaryPasswordExpiresAt!.getTime()).toBeGreaterThan(
        Date.now(),
      );
      expect(
        await authenticate({
          email: user.email,
          password: "recovery-password",
        }),
      ).toMatchObject({
        actor: { testingOnly: true, mustChangePassword: true },
      });
      await expect(listTestingExperiments(f.actor(user), {})).rejects.toThrow();
      await expect(
        revealAccountHandoff(f.actor(f.admin), f.provision.handoffId),
      ).rejects.toThrow();
      await changePassword(f.actor(user), {
        current: "recovery-password",
        next: "personal-recovered-password",
      });
      expect(
        await authenticate({
          email: user.email,
          password: "personal-recovered-password",
        }),
      ).toMatchObject({
        actor: { testingOnly: true, mustChangePassword: false },
      });
    } finally {
      await f.cleanup();
    }
  });
  it("rolls back testing requests and notifications together when audit fails, without external delivery", async () => {
    const f = await fixture();
    try {
      vi.mocked(sendGroupNotice).mockClear();
      const spy = vi
        .spyOn(audit, "recordUserAudit")
        .mockRejectedValueOnce(new Error("synthetic testing audit failure"));
      await expect(requestTesting(f.actor(f.admin), f.request)).rejects.toThrow(
        "synthetic testing audit failure",
      );
      spy.mockRestore();
      expect(
        await db.testingRequest.count({ where: { organizationId: f.org.id } }),
      ).toBe(0);
      expect(
        await db.notification.count({
          where: { organizationId: f.org.id, kind: "testing_requested" },
        }),
      ).toBe(0);
      expect(sendGroupNotice).not.toHaveBeenCalled();
    } finally {
      await f.cleanup();
    }
  });
  it("commits a scoped, idempotent request before external delivery with only selected substrates and photo", async () => {
    const f = await fixture();
    const foreign = await fixture();
    try {
      const tester = await f.activate();
      vi.mocked(sendGroupNotice).mockClear();
      vi.mocked(sendGroupNotice).mockImplementation(async () => {
        expect(
          await db.testingRequest.count({
            where: { organizationId: f.org.id },
          }),
        ).toBe(1);
        expect(
          await db.notification.count({
            where: { userId: tester.uid, kind: "testing_requested" },
          }),
        ).toBe(1);
        return true;
      });
      const results = await Promise.all([
        requestTesting(f.actor(f.admin), f.request),
        requestTesting(f.actor(f.admin), f.request),
      ]);
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(sendGroupNotice).toHaveBeenCalledTimes(1);
      const detail = await getTestingExperiment(tester, f.experiment.id);
      expect(detail?.requests[0].samples.map((s) => s.id)).toEqual(
        f.request.sampleIds,
      );
      expect(await readTestingPhoto(tester, results[0].id)).toMatchObject({
        contentType: "image/png",
      });
      expect(
        await readTestingPhoto(
          { ...tester, org: foreign.org.id },
          results[0].id,
        ).catch(() => null),
      ).toBeNull();
      await expect(
        requestTesting(f.actor(f.admin), {
          ...f.request,
          requestKey: crypto.randomUUID(),
          sampleIds: [foreign.experiment.samples[0].id],
        }),
      ).rejects.toThrow();
      await expect(
        requestTesting(f.actor(f.admin), {
          ...f.request,
          requestKey: crypto.randomUUID(),
          photoPath: foreign.request.photoPath,
        }),
      ).rejects.toThrow();
      await expect(
        requestTesting(f.actor(f.admin), { ...f.request, note: "changed" }),
      ).rejects.toThrow("already used");
    } finally {
      await f.cleanup();
      await foreign.cleanup();
    }
  });
  it("expires temporary logins and rolls back account/notification writes if auditing fails", async () => {
    const f = await fixture();
    try {
      const past = new Date(Date.now() - 1000);
      await db.user.update({
        where: { id: f.tester.id },
        data: { temporaryPasswordExpiresAt: past },
      });
      await db.accountHandoff.update({
        where: { id: f.provision.handoffId },
        data: { expiresAt: past },
      });
      expect(
        await authenticate({ email: f.tester.email, password: f.password }),
      ).toBeNull();
      await expect(
        revealAccountHandoff(f.actor(f.admin), f.provision.handoffId),
      ).rejects.toThrow();
      const spy = vi
        .spyOn(audit, "recordSystemAudit")
        .mockRejectedValueOnce(new Error("synthetic audit failure"));
      await expect(
        provisionTestingAccount({
          ...f.input,
          email: `rollback-${f.input.email}`,
        }),
      ).rejects.toThrow("synthetic audit failure");
      spy.mockRestore();
      expect(
        await db.accountHandoff.count({ where: { organizationId: f.org.id } }),
      ).toBe(1);
      expect(
        await db.user.count({
          where: { organizationId: f.org.id, testingOnly: true },
        }),
      ).toBe(1);
      expect(
        await db.notification.count({
          where: { organizationId: f.org.id, kind: "account_setup_ready" },
        }),
      ).toBe(2);
    } finally {
      await f.cleanup();
    }
  });
});
