import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/infrastructure/db/client";
import { objectStorage } from "@/infrastructure/storage";
import type { Actor } from "@/modules/authorization/actor";
import * as audit from "@/modules/audit/writer";
import {
  listLabReports,
  canOpenReports,
  getLabReportMetadata,
} from "@/modules/reports/query";
import {
  publishLabReport,
  readLabReportContent,
} from "@/modules/reports/service";
import { canReadObject } from "@/modules/files/authorization";

afterEach(() => vi.restoreAllMocks());
afterAll(() => db.$disconnect());
async function fixture() {
  const suffix = crypto.randomUUID();
  const org = await db.organization.create({
    data: { name: "Reports fixture", slug: `reports-${suffix}` },
  });
  const foreign = await db.organization.create({
    data: { name: "Foreign reports", slug: `foreign-reports-${suffix}` },
  });
  const member = (
    name: string,
    role: "ADMIN" | "MANAGER" | "TECHNICIAN",
    extra = {},
  ) =>
    db.user.create({
      data: {
        organizationId: org.id,
        name,
        role,
        email: `${name}-${suffix}@example.test`,
        passwordHash: "test-only",
        ...extra,
      },
    });
  const admin = await member("admin", "ADMIN");
  const managers = await Promise.all([
    member("m1", "MANAGER"),
    member("m2", "MANAGER", { language: "zh" }),
    member("m3", "MANAGER"),
  ]);
  const ordinary = await member("ordinary", "MANAGER");
  const tester = await member("tester", "TECHNICIAN", { testingOnly: true });
  const outside = await member("outside", "ADMIN", {
    organizationId: foreign.id,
    reportAccess: true,
  });
  const actor = (user: typeof admin): Actor => ({
    uid: user.id,
    org: user.organizationId,
    role: user.role,
    testingOnly: user.testingOnly,
    mustChangePassword: user.mustChangePassword,
  });
  const html =
    '<!DOCTYPE html><html><head><style>body{color:green}</style></head><body>PRIVATE REPORT<script>document.title="Report";</script></body></html>';
  const input = {
    organizationId: org.id,
    publicationKey: "synthetic-report-v1",
    titleEn: "Materials report",
    titleZh: "材料报告",
    generatedAt: new Date("2026-10-12T03:00:00Z"),
    html,
    recipientIds: [admin.id, ...managers.map((u) => u.id)],
    authorizationReference: "Synthetic approved publication",
  };
  return {
    org,
    foreign,
    admin,
    managers,
    ordinary,
    tester,
    outside,
    actor,
    html,
    input,
    async cleanup() {
      for (const organizationId of [org.id, foreign.id]) {
        const where = { organizationId };
        for (const report of await db.labReport.findMany({ where }))
          await objectStorage().delete(report.storedPath);
        await db.labReport.deleteMany({ where });
        await db.notification.deleteMany({ where });
        await db.auditEvent.deleteMany({ where });
        await db.user.deleteMany({ where });
        await db.organization.delete({ where: { id: organizationId } });
      }
    },
  };
}
describe("private reports on real PostgreSQL", () => {
  it("grants precisely four recipients and atomically emits four unread notices, once", async () => {
    const f = await fixture();
    try {
      expect(await canOpenReports(f.actor(f.admin))).toBe(false);
      const result = await publishLabReport(f.input);
      expect(result).toMatchObject({ created: true, notifiedRecipients: 4 });
      expect(
        await db.user.count({
          where: { organizationId: f.org.id, reportAccess: true },
        }),
      ).toBe(4);
      const notices = await db.notification.findMany({
        where: { organizationId: f.org.id },
      });
      expect(notices).toHaveLength(4);
      expect(
        notices.every(
          (n) => n.readAt === null && n.href === `/reports/${result.id}`,
        ),
      ).toBe(true);
      expect(
        notices.find((n) => n.userId === f.managers[1].id)?.entityLabel,
      ).toBe("材料报告");
      expect(await publishLabReport(f.input)).toMatchObject({
        created: false,
        notifiedRecipients: 0,
      });
      await expect(
        publishLabReport({
          ...f.input,
          html: f.html.replace("PRIVATE", "DIFFERENT"),
        }),
      ).rejects.toThrow("different content");
      expect(
        await db.notification.count({ where: { organizationId: f.org.id } }),
      ).toBe(4);
      expect(
        await db.auditEvent.count({
          where: { organizationId: f.org.id, action: "report.published" },
        }),
      ).toBe(1);
    } finally {
      await f.cleanup();
    }
  });
  it("exposes only title/date metadata to regular users and denies direct, generic-file and cross-organization content", async () => {
    const f = await fixture();
    try {
      const result = await publishLabReport(f.input);
      const list = await listLabReports(f.actor(f.ordinary), {});
      expect(list.canOpen).toBe(false);
      expect(Object.keys(list.rows[0]).sort()).toEqual(
        ["generatedAt", "id", "titleEn", "titleZh"].sort(),
      );
      await expect(
        readLabReportContent(f.actor(f.ordinary), result.id),
      ).rejects.toThrow();
      await expect(
        getLabReportMetadata(f.actor(f.ordinary), result.id),
      ).rejects.toThrow();
      expect(
        await readLabReportContent(f.actor(f.outside), result.id),
      ).toBeNull();
      expect((await listLabReports(f.actor(f.outside), {})).rows).toHaveLength(
        0,
      );
      const row = await db.labReport.findUniqueOrThrow({
        where: { id: result.id },
      });
      expect(await canReadObject(f.actor(f.admin), row.storedPath)).toBe(false);
      await expect(listLabReports(f.actor(f.tester), {})).rejects.toThrow();
      const content = await readLabReportContent(f.actor(f.admin), result.id);
      expect(Buffer.from(content!.body).toString()).toBe(f.html);
      expect(content!.contentSecurityPolicy).not.toContain("allow-same-origin");
      expect(
        await db.auditEvent.count({
          where: { organizationId: f.org.id, action: "report.content.read" },
        }),
      ).toBe(1);
    } finally {
      await f.cleanup();
    }
  });
  it("rechecks fresh grants, role, setup, approval and active status and fails closed on tampered HTML", async () => {
    const f = await fixture();
    try {
      const result = await publishLabReport(f.input);
      for (const change of [
        { reportAccess: false },
        { role: "TECHNICIAN" as const },
        { mustChangePassword: true },
        { pendingApproval: true },
        { active: false },
        { testingOnly: true },
      ]) {
        await db.user.update({ where: { id: f.admin.id }, data: change });
        await expect(
          readLabReportContent(f.actor(f.admin), result.id),
        ).rejects.toThrow();
        await db.user.update({
          where: { id: f.admin.id },
          data: {
            reportAccess: true,
            role: "ADMIN",
            mustChangePassword: false,
            pendingApproval: false,
            active: true,
            testingOnly: false,
          },
        });
      }
      await db.organization.update({
        where: { id: f.org.id },
        data: { status: "SUSPENDED" },
      });
      await expect(
        readLabReportContent(f.actor(f.admin), result.id),
      ).rejects.toThrow();
      await db.organization.update({
        where: { id: f.org.id },
        data: { status: "ACTIVE" },
      });
      const row = await db.labReport.findUniqueOrThrow({
        where: { id: result.id },
      });
      await objectStorage().put({
        key: row.storedPath,
        body: Buffer.from("altered"),
        contentType: "text/html",
      });
      await expect(
        readLabReportContent(f.actor(f.admin), result.id),
      ).rejects.toThrow("integrity");
    } finally {
      await f.cleanup();
    }
  });
  it("rejects foreign or restricted recipients and rolls back grants, notices and storage if audit fails", async () => {
    const f = await fixture();
    try {
      for (const id of [f.outside.id, f.tester.id])
        await expect(
          publishLabReport({ ...f.input, recipientIds: [id] }),
        ).rejects.toThrow("active manager");
      const put = vi.spyOn(objectStorage(), "put");
      vi.spyOn(audit, "recordSystemAudit").mockRejectedValueOnce(
        new Error("synthetic audit failure"),
      );
      await expect(publishLabReport(f.input)).rejects.toThrow(
        "synthetic audit failure",
      );
      expect(
        await db.labReport.count({ where: { organizationId: f.org.id } }),
      ).toBe(0);
      expect(
        await db.notification.count({ where: { organizationId: f.org.id } }),
      ).toBe(0);
      expect(
        await db.user.count({
          where: { organizationId: f.org.id, reportAccess: true },
        }),
      ).toBe(0);
      expect(await objectStorage().exists(put.mock.calls[0][0].key)).toBe(
        false,
      );
    } finally {
      await f.cleanup();
    }
  });
});
