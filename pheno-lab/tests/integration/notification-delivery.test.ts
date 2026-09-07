import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { db } from "@/infrastructure/db/client";
import { serverConfig } from "@/infrastructure/config/server";
import { parseServerConfig } from "@/infrastructure/config/schema";
import { sendDingTalkText } from "@/infrastructure/push/dingtalk";
import type { Actor } from "@/modules/authorization/actor";
import * as auditWriter from "@/modules/audit/writer";
import { requestAccess } from "@/modules/experiments/access-request-service";
import { assignExperiment } from "@/modules/workflow/service";
import { verifyRegistration } from "@/modules/accounts/registration-service";
import {
  saveMaterialCard,
  saveRecipe,
  submitMaterialEdit,
} from "@/modules/library/service";
import { sendGroupNotice } from "@/modules/notifications/group-service";
import { runMorningDigest } from "@/modules/notifications/digest-service";

vi.mock("@/infrastructure/config/server");
vi.mock("@/infrastructure/push/dingtalk");

const materialCard = {
  name: "Private material",
  category: "OTHER",
  composition: "",
  smiles: "",
  casNumber: "",
  molecularWeight: "",
  purity: "",
  supplier: "",
  lot: "",
  properties: {},
  notes: "",
  processId: null,
};

const recipePayload = {
  components: [{ material: "Private ingredient", amount: "1" }],
  solvents: "",
  concentration: "",
  procedure: "",
};

function configure(slug?: string) {
  vi.mocked(serverConfig).mockReturnValue(
    parseServerConfig({
      ...process.env,
      DINGTALK_WEBHOOK_URL:
        "https://oapi.dingtalk.com/robot/send?access_token=synthetic-test-token",
      DINGTALK_WEBHOOK_SECRET: undefined,
      DINGTALK_ORGANIZATION_SLUG: slug,
    }),
  );
}

beforeEach(() => {
  vi.mocked(sendDingTalkText).mockReset().mockResolvedValue(true);
  configure();
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => db.$disconnect());

async function fixture() {
  const organization = await db.organization.create({
    data: {
      name: "Private test organization",
      slug: `push-${crypto.randomUUID()}`,
    },
  });
  const owner = await db.user.create({
    data: {
      organizationId: organization.id,
      name: "Private test owner",
      email: `${crypto.randomUUID()}@example.test`,
      passwordHash: "test-only",
      role: "ADMIN",
      userNumber: 1,
    },
  });
  const requester = await db.user.create({
    data: {
      organizationId: organization.id,
      name: "Private test requester",
      email: `${crypto.randomUUID()}@example.test`,
      passwordHash: "test-only",
      role: "TECHNICIAN",
      userNumber: 2,
    },
  });
  const ownerActor: Actor = {
    uid: owner.id,
    org: organization.id,
    role: owner.role,
  };
  const requesterActor: Actor = {
    uid: requester.id,
    org: organization.id,
    role: requester.role,
  };
  const experiment = await db.experiment.create({
    data: {
      organizationId: organization.id,
      createdById: owner.id,
      title: "Private experimental title",
      code: `PRIVATE-${crypto.randomUUID()}`,
    },
  });
  return {
    organization,
    ownerActor,
    requesterActor,
    experiment,
    async cleanup() {
      const where = { organizationId: organization.id };
      await db.notification.deleteMany({ where });
      await db.auditEvent.deleteMany({ where });
      await db.instrument.deleteMany({ where });
      await db.experiment.deleteMany({ where });
      await db.material.deleteMany({ where });
      await db.recipe.deleteMany({ where });
      await db.otpCode.deleteMany({ where });
      await db.user.deleteMany({ where });
      await db.organization.delete({ where: { id: organization.id } });
    },
  };
}

describe("organization-scoped notification delivery", () => {
  it("does not route unconfigured, foreign or inactive organizations", async () => {
    const context = await fixture();
    try {
      expect(await sendGroupNotice(context.organization.id, "assigned")).toBe(
        false,
      );
      expect(await runMorningDigest()).toBe("disabled");
      configure(`foreign-${crypto.randomUUID()}`);
      expect(await sendGroupNotice(context.organization.id, "assigned")).toBe(
        false,
      );
      configure(context.organization.slug);
      expect(await sendGroupNotice("foreign-organization", "assigned")).toBe(
        false,
      );
      await db.organization.update({
        where: { id: context.organization.id },
        data: { status: "PENDING" },
      });
      expect(await sendGroupNotice(context.organization.id, "assigned")).toBe(
        false,
      );
      expect(await runMorningDigest()).toBe("disabled");
      expect(sendDingTalkText).not.toHaveBeenCalled();
    } finally {
      await context.cleanup();
    }
  });

  it("delivers only after commit and does not repeat an open access request", async () => {
    const context = await fixture();
    try {
      configure(context.organization.slug);
      const visibleAtDelivery: number[][] = [];
      vi.mocked(sendDingTalkText).mockImplementation(async () => {
        visibleAtDelivery.push([
          await db.accessRequest.count({
            where: { experimentId: context.experiment.id },
          }),
          await db.auditEvent.count({
            where: {
              entityId: context.experiment.id,
              action: "experiment.access_requested",
            },
          }),
          await db.notification.count({
            where: { organizationId: context.organization.id },
          }),
        ]);
        return true;
      });
      const request = {
        experimentId: context.experiment.id,
        message: "confidential request reason",
      };
      await Promise.all([
        requestAccess(context.requesterActor, request),
        requestAccess(context.requesterActor, request),
      ]);
      await requestAccess(context.requesterActor, request);
      expect(sendDingTalkText).toHaveBeenCalledTimes(1);
      expect(visibleAtDelivery).toEqual([[1, 1, 1]]);
      expect(vi.mocked(sendDingTalkText).mock.calls[0][0]).not.toMatch(
        /Private|PRIVATE|confidential/,
      );
    } finally {
      await context.cleanup();
    }
  });

  it("never sends a rolled-back action and preserves committed work on delivery failure", async () => {
    const context = await fixture();
    try {
      configure(context.organization.slug);
      const audit = vi
        .spyOn(auditWriter, "recordUserAudit")
        .mockRejectedValueOnce(new Error("test audit failure"));
      const request = { experimentId: context.experiment.id, message: "test" };
      await expect(
        requestAccess(context.requesterActor, request),
      ).rejects.toThrow("test audit failure");
      expect(
        await db.accessRequest.count({
          where: { experimentId: context.experiment.id },
        }),
      ).toBe(0);
      expect(
        await db.notification.count({
          where: { organizationId: context.organization.id },
        }),
      ).toBe(0);
      expect(sendDingTalkText).not.toHaveBeenCalled();
      audit.mockRestore();
      vi.mocked(sendDingTalkText).mockRejectedValueOnce(
        new Error("synthetic network failure"),
      );
      await expect(
        requestAccess(context.requesterActor, request),
      ).resolves.toBeUndefined();
      expect(
        await db.accessRequest.count({
          where: { experimentId: context.experiment.id },
        }),
      ).toBe(1);
      expect(
        await db.auditEvent.count({
          where: {
            entityId: context.experiment.id,
            action: "experiment.access_requested",
          },
        }),
      ).toBe(1);
    } finally {
      await context.cleanup();
    }
  });

  it("wires assignment, registration and library requests without exporting identities or contents", async () => {
    const context = await fixture();
    try {
      configure(context.organization.slug);
      await assignExperiment(context.ownerActor, {
        experimentId: context.experiment.id,
        userId: context.requesterActor.uid,
      });
      await assignExperiment(context.ownerActor, {
        experimentId: context.experiment.id,
        userId: context.requesterActor.uid,
      });
      expect(sendDingTalkText).toHaveBeenCalledTimes(1);
      const email = `${crypto.randomUUID()}@example.test`;
      await db.otpCode.create({
        data: {
          organizationId: context.organization.id,
          email,
          code: "123456",
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      expect(
        await verifyRegistration({
          email,
          code: "123456",
          name: "Private new registrant",
          password: "test-registration-password",
        }),
      ).toEqual({ ok: true });
      expect(
        await db.user.count({
          where: {
            organizationId: context.organization.id,
            pendingApproval: true,
          },
        }),
      ).toBe(1);
      const material = await saveMaterialCard(
        context.requesterActor,
        null,
        materialCard,
      );
      await submitMaterialEdit(context.requesterActor, {
        materialId: material.id,
        changes: { ...material, properties: {}, notes: "confidential edit" },
      });
      await saveRecipe(context.requesterActor, {
        id: null,
        data: {
          name: "Private recipe",
          summary: "confidential",
          payload: recipePayload,
        },
      });
      expect(sendDingTalkText).toHaveBeenCalledTimes(4);
      for (const [text] of vi.mocked(sendDingTalkText).mock.calls) {
        expect(text).not.toMatch(
          /Private|PRIVATE|confidential|123456|example\.test/,
        );
      }
    } finally {
      await context.cleanup();
    }
  });
});

it("keeps test assignments out of the group", async () => {
  const context = await fixture();
  try {
    configure(context.organization.slug);
    await db.experiment.update({
      where: { id: context.experiment.id },
      data: { isTest: true },
    });
    await assignExperiment(context.ownerActor, {
      experimentId: context.experiment.id,
      userId: context.requesterActor.uid,
    });
    expect(sendDingTalkText).not.toHaveBeenCalled();
    expect(
      (
        await db.experiment.findUniqueOrThrow({
          where: { id: context.experiment.id },
        })
      ).assigneeId,
    ).toBe(context.requesterActor.uid);
  } finally {
    await context.cleanup();
  }
});

describe("morning digest on PostgreSQL", () => {
  const morning = new Date("2026-09-08T00:30:00Z");

  it("aggregates the previous Beijing day and claims one attempt under concurrency", async () => {
    const context = await fixture();
    const foreign = await fixture();
    try {
      configure(context.organization.slug);
      const where = { organizationId: context.organization.id };
      const testExperiment = await db.experiment.create({
        data: {
          ...where,
          createdById: context.ownerActor.uid,
          title: "Private test run",
          code: `TEST-${crypto.randomUUID()}`,
          isTest: true,
        },
      });
      const currentExperiment = await db.experiment.create({
        data: {
          ...where,
          createdById: context.ownerActor.uid,
          title: "Private current day",
          code: `CURRENT-${crypto.randomUUID()}`,
        },
      });
      const yesterday = new Date("2026-09-07T02:00:00Z");
      await db.auditEvent.createMany({
        data: [
          {
            ...where,
            entityId: context.experiment.id,
            action: "experiment.approve",
            createdAt: yesterday,
          },
          {
            ...where,
            entityId: context.experiment.id,
            action: "experiment.update",
            createdAt: yesterday,
          },
          {
            ...where,
            entityId: testExperiment.id,
            action: "experiment.complete-from-capture",
            createdAt: yesterday,
          },
          {
            ...where,
            entityId: currentExperiment.id,
            action: "experiment.approve",
            createdAt: new Date("2026-09-07T16:00:00Z"),
          },
          {
            organizationId: foreign.organization.id,
            entityId: foreign.experiment.id,
            action: "experiment.approve",
            createdAt: yesterday,
          },
        ].map((event) => ({
          ...event,
          entityType: "Experiment",
          actorType: "USER",
          changes: { status: "COMPLETE" },
        })),
      });
      await db.user.create({
        data: {
          ...where,
          name: "Private pending",
          email: `${crypto.randomUUID()}@example.test`,
          passwordHash: "test-only",
          active: false,
          pendingApproval: true,
        },
      });
      await db.accessRequest.create({
        data: {
          experimentId: context.experiment.id,
          requesterId: context.requesterActor.uid,
        },
      });
      const material = await saveMaterialCard(
        context.requesterActor,
        null,
        materialCard,
      );
      await submitMaterialEdit(context.requesterActor, {
        materialId: material.id,
        changes: { ...material, properties: {}, notes: "test" },
      });
      await saveRecipe(context.requesterActor, {
        id: null,
        data: {
          name: "Private recipe",
          summary: "",
          payload: recipePayload,
        },
      });
      const instrument = await db.instrument.create({
        data: {
          ...where,
          name: "Private instrument",
          kind: "GIANTFORCE_IV",
          apiKeyHash: crypto.randomUUID(),
        },
      });
      const upload = await db.instrumentUpload.create({
        data: {
          instrumentId: instrument.id,
          fileName: "synthetic.csv",
          storedPath: "synthetic/digest-test.csv",
          sha256: crypto.randomUUID(),
          size: 1,
          status: "PARSED",
        },
      });
      for (const scan of [
        { pce: 25.25 },
        {
          pce: 99,
          experimentId: foreign.experiment.id,
          organizationId: foreign.organization.id,
        },
        { pce: 98, experimentId: testExperiment.id },
        { pce: 95, condition: "DARK" },
        { pce: 90, measuredAt: new Date("2026-09-07T16:00:00Z") },
        { pce: 89, measuredAt: new Date("2026-09-06T15:59:59Z") },
        { pce: 88, status: "UNMATCHED", experimentId: null },
        { pce: -1 },
        { pce: 100.01 },
        { pce: "77" },
      ]) {
        const { pce, ...overrides } = scan;
        await db.jvMeasurement.create({
          data: {
            ...where,
            instrumentId: instrument.id,
            uploadId: upload.id,
            serial: "synthetic",
            serialKey: "synthetic",
            scanKey: crypto.randomUUID(),
            status: "MATCHED",
            condition: "LIGHT",
            measuredAt: yesterday,
            experimentId: context.experiment.id,
            curve: [],
            metrics: { pce },
            ...overrides,
          },
        });
      }
      vi.mocked(sendDingTalkText).mockClear();
      const results = await Promise.all([
        runMorningDigest(morning),
        runMorningDigest(morning),
      ]);
      expect(results.sort()).toEqual(["sent", "skipped"]);
      expect(sendDingTalkText).toHaveBeenCalledTimes(1);
      const text = vi.mocked(sendDingTalkText).mock.calls[0][0];
      expect(text).toContain("早间摘要 2026-09-08（北京时间）");
      for (const line of [
        "昨日完成实验：1",
        "昨日最高有效光照扫描 PCE：25.25%",
        "待审批注册：1",
        "待处理访问申请：1",
        "待审批材料修改：1",
        "待审批配方：1",
        "未匹配扫描：1",
      ])
        expect(text).toContain(line);
      expect(text).not.toMatch(/Private|PRIVATE|synthetic|example\.test/);
      expect(await runMorningDigest(morning)).toBe("skipped");
      expect(
        await db.auditEvent.count({
          where: { ...where, action: "notifications.digest.attempted" },
        }),
      ).toBe(1);
      expect(
        await db.auditEvent.count({
          where: { ...where, action: "notifications.digest.sent" },
        }),
      ).toBe(1);
    } finally {
      await context.cleanup();
      await foreign.cleanup();
    }
  });

  it("records a failed attempt without retrying that day or claiming delivery", async () => {
    const context = await fixture();
    try {
      configure(context.organization.slug);
      vi.mocked(sendDingTalkText).mockResolvedValue(false);
      expect(await runMorningDigest(morning)).toBe("failed");
      expect(await runMorningDigest(morning)).toBe("skipped");
      expect(sendDingTalkText).toHaveBeenCalledTimes(1);
      expect(
        await db.auditEvent.count({
          where: {
            organizationId: context.organization.id,
            action: "notifications.digest.failed",
          },
        }),
      ).toBe(1);
      expect(
        await db.auditEvent.count({
          where: {
            organizationId: context.organization.id,
            action: "notifications.digest.sent",
          },
        }),
      ).toBe(0);
      vi.mocked(sendDingTalkText).mockResolvedValue(true);
      expect(await runMorningDigest(new Date("2026-09-09T00:30:00Z"))).toBe(
        "sent",
      );
      expect(sendDingTalkText).toHaveBeenCalledTimes(2);
    } finally {
      await context.cleanup();
    }
  });
});
