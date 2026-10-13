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
  grantReportAccess,
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
  const reader = await member("reader", "TECHNICIAN", { language: "zh" });
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
    reader,
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
        await db.feedback.deleteMany({ where });
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
      expect(
        await db.auditEvent.count({
          where: {
            organizationId: f.org.id,
            action: "user.report_access.granted",
          },
        }),
      ).toBe(4);
    } finally {
      await f.cleanup();
    }
  });
  it("publishes recurring reports to four existing grantees without changing grants", async () => {
    const f = await fixture();
    try {
      await db.user.updateMany({
        where: { id: { in: f.input.recipientIds }, organizationId: f.org.id },
        data: { reportAccess: true },
      });
      const input = { ...f.input, requireExistingAccess: true };
      const put = vi.spyOn(objectStorage(), "put");
      const result = await publishLabReport(input);
      expect(result).toMatchObject({ created: true, notifiedRecipients: 4 });
      expect(put).toHaveBeenCalledTimes(1);
      expect(
        await db.user.count({
          where: { organizationId: f.org.id, reportAccess: true },
        }),
      ).toBe(4);
      const notices = await db.notification.findMany({
        where: { organizationId: f.org.id },
      });
      expect(notices).toHaveLength(4);
      expect(notices.map((notice) => notice.userId).sort()).toEqual(
        [...f.input.recipientIds].sort(),
      );
      expect(
        notices.every(
          (notice) =>
            notice.readAt === null && notice.href === `/reports/${result.id}`,
        ),
      ).toBe(true);
      expect(await publishLabReport(input)).toMatchObject({
        id: result.id,
        created: false,
        notifiedRecipients: 0,
      });
      expect(put).toHaveBeenCalledTimes(1);
      expect(
        await db.notification.count({ where: { organizationId: f.org.id } }),
      ).toBe(4);
      expect(
        await db.auditEvent.count({
          where: {
            organizationId: f.org.id,
            action: "user.report_access.granted",
          },
        }),
      ).toBe(0);
      expect(
        await db.auditEvent.count({
          where: { organizationId: f.org.id, action: "report.published" },
        }),
      ).toBe(1);
    } finally {
      await f.cleanup();
    }
  });
  it("rejects a recurring publication with a revoked grant before writing storage, records or notices", async () => {
    const f = await fixture();
    try {
      await db.user.updateMany({
        where: { id: { in: f.input.recipientIds }, organizationId: f.org.id },
        data: { reportAccess: true },
      });
      await db.user.update({
        where: { id: f.managers[0].id },
        data: { reportAccess: false },
      });
      const before = await db.user.findMany({
        where: { organizationId: f.org.id },
        select: { id: true, reportAccess: true },
        orderBy: { id: "asc" },
      });
      const put = vi.spyOn(objectStorage(), "put");
      const remove = vi.spyOn(objectStorage(), "delete");
      await expect(
        publishLabReport({ ...f.input, requireExistingAccess: true }),
      ).rejects.toThrow("already have report access");
      expect(put).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      expect(
        await db.user.findMany({
          where: { organizationId: f.org.id },
          select: { id: true, reportAccess: true },
          orderBy: { id: "asc" },
        }),
      ).toEqual(before);
      expect(
        await db.labReport.count({ where: { organizationId: f.org.id } }),
      ).toBe(0);
      expect(
        await db.notification.count({ where: { organizationId: f.org.id } }),
      ).toBe(0);
      expect(
        await db.auditEvent.count({ where: { organizationId: f.org.id } }),
      ).toBe(0);
    } finally {
      await f.cleanup();
    }
  });
  it("rechecks current grants and restrictions before returning an identical recurring publication", async () => {
    const f = await fixture();
    try {
      await db.user.updateMany({
        where: { id: { in: f.input.recipientIds }, organizationId: f.org.id },
        data: { reportAccess: true },
      });
      const input = { ...f.input, requireExistingAccess: true };
      const published = await publishLabReport(input);
      const put = vi.spyOn(objectStorage(), "put");
      for (const change of [
        { reportAccess: false },
        { mustChangePassword: true },
        { pendingApproval: true },
        { active: false },
        { testingOnly: true },
      ]) {
        await db.user.update({ where: { id: f.admin.id }, data: change });
        const before = await db.user.findUniqueOrThrow({
          where: { id: f.admin.id },
        });
        await expect(publishLabReport(input)).rejects.toThrow(
          "reportAccess" in change
            ? "report access"
            : "eligible active account",
        );
        expect(
          await db.user.findUniqueOrThrow({ where: { id: f.admin.id } }),
        ).toEqual(before);
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
      await expect(publishLabReport(input)).rejects.toThrow(
        "active organization",
      );
      expect(put).not.toHaveBeenCalled();
      expect(
        await db.labReport.findMany({
          where: { organizationId: f.org.id },
          select: { id: true },
        }),
      ).toEqual([{ id: published.id }]);
      expect(
        await db.notification.count({ where: { organizationId: f.org.id } }),
      ).toBe(4);
      expect(
        await db.auditEvent.count({ where: { organizationId: f.org.id } }),
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
      await db.feedback.create({
        data: {
          organizationId: f.org.id,
          userId: f.ordinary.id,
          kind: "bug",
          message: "Synthetic legacy reference",
          screenshotPath: row.storedPath,
        },
      });
      expect(await canReadObject(f.actor(f.admin), row.storedPath)).toBe(false);
      expect(await canReadObject(f.actor(f.ordinary), row.storedPath)).toBe(
        false,
      );
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
  it("grants a technician only report access, opens historical reports and notifies once", async () => {
    const f = await fixture();
    try {
      const published = await publishLabReport(f.input);
      const input = {
        organizationId: f.org.id,
        senderUserId: f.admin.id,
        recipientUserId: f.reader.id,
        requestId: "synthetic-technician-report-access-v1",
        authorizationReference: "Synthetic explicit report access approval",
      };
      const before = await db.user.findUniqueOrThrow({
        where: { id: f.reader.id },
      });
      const otherUsers = await db.user.findMany({
        where: { organizationId: f.org.id, id: { not: f.reader.id } },
        orderBy: { id: "asc" },
      });
      expect(await canOpenReports(f.actor(f.reader))).toBe(false);
      expect(await grantReportAccess(input)).toEqual({
        created: true,
        granted: true,
        notifiedRecipients: 1,
      });
      expect(
        await db.user.findUniqueOrThrow({ where: { id: f.reader.id } }),
      ).toEqual({ ...before, reportAccess: true });
      expect(
        await db.user.findMany({
          where: { organizationId: f.org.id, id: { not: f.reader.id } },
          orderBy: { id: "asc" },
        }),
      ).toEqual(otherUsers);
      expect(await canOpenReports(f.actor(f.reader))).toBe(true);
      expect((await listLabReports(f.actor(f.reader), {})).canOpen).toBe(true);
      expect(
        await getLabReportMetadata(f.actor(f.reader), published.id),
      ).not.toBeNull();
      const content = await readLabReportContent(
        f.actor(f.reader),
        published.id,
      );
      expect(Buffer.from(content!.body).toString()).toBe(f.html);
      const original = await db.labReport.findUniqueOrThrow({
        where: { id: published.id },
      });
      expect(original.recipientIds).toEqual([...f.input.recipientIds].sort());
      expect(await canReadObject(f.actor(f.reader), original.storedPath)).toBe(
        false,
      );
      expect(await grantReportAccess(input)).toEqual({
        created: false,
        granted: false,
        notifiedRecipients: 0,
      });
      const notices = await db.notification.findMany({
        where: { organizationId: f.org.id, userId: f.reader.id },
      });
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({
        kind: "report_access_granted",
        actorName: f.admin.name,
        entityLabel: "Pheno Lab 研究报告",
        href: "/reports",
        readAt: null,
      });
      expect(
        await db.auditEvent.count({
          where: {
            organizationId: f.org.id,
            entityId: f.reader.id,
            action: "user.report_access.granted",
          },
        }),
      ).toBe(1);
      expect(
        await db.auditEvent.count({
          where: {
            organizationId: f.org.id,
            entityId: f.reader.id,
            action: "report.access.announced",
            requestId: input.requestId,
          },
        }),
      ).toBe(1);
      await expect(
        grantReportAccess({
          ...input,
          authorizationReference: "Different approval",
        }),
      ).rejects.toThrow("different input");
    } finally {
      await f.cleanup();
    }
  });
  it("publishes to five pregranted readers while legacy initial grants remain managerial", async () => {
    const f = await fixture();
    try {
      await publishLabReport(f.input);
      await expect(
        publishLabReport({
          ...f.input,
          publicationKey: "synthetic-initial-technician-v1",
          recipientIds: [f.reader.id],
        }),
      ).rejects.toThrow("active manager");
      await grantReportAccess({
        organizationId: f.org.id,
        senderUserId: f.admin.id,
        recipientUserId: f.reader.id,
        requestId: "synthetic-five-recipient-grant-v1",
        authorizationReference: "Synthetic explicit technician report approval",
      });
      const grantsBefore = await db.auditEvent.count({
        where: {
          organizationId: f.org.id,
          action: "user.report_access.granted",
        },
      });
      const input = {
        ...f.input,
        publicationKey: "synthetic-five-recipient-report-v1",
        recipientIds: [...f.input.recipientIds, f.reader.id],
        requireExistingAccess: true,
      };
      const result = await publishLabReport(input);
      expect(result).toMatchObject({ created: true, notifiedRecipients: 5 });
      const notices = await db.notification.findMany({
        where: { organizationId: f.org.id, href: `/reports/${result.id}` },
      });
      expect(notices.map((notice) => notice.userId).sort()).toEqual(
        [...input.recipientIds].sort(),
      );
      expect(notices.every((notice) => notice.readAt === null)).toBe(true);
      expect(await publishLabReport(input)).toMatchObject({
        created: false,
        notifiedRecipients: 0,
      });
      expect(
        await db.auditEvent.count({
          where: {
            organizationId: f.org.id,
            action: "user.report_access.granted",
          },
        }),
      ).toBe(grantsBefore);
      expect(
        await db.user.findUniqueOrThrow({
          where: { id: f.reader.id },
          select: { role: true },
        }),
      ).toEqual({ role: "TECHNICIAN" });
      await expect(
        readLabReportContent(f.actor(f.ordinary), result.id),
      ).rejects.toThrow();
      expect(
        await readLabReportContent(f.actor(f.outside), result.id),
      ).toBeNull();
    } finally {
      await f.cleanup();
    }
  });
  it("rejects foreign and restricted access targets and non-admin senders without writes", async () => {
    const f = await fixture();
    try {
      const input = {
        organizationId: f.org.id,
        senderUserId: f.admin.id,
        recipientUserId: f.reader.id,
        requestId: "synthetic-restricted-report-grant-v1",
        authorizationReference: "Synthetic scoped report access approval",
      };
      for (const recipientUserId of [f.outside.id, f.tester.id])
        await expect(
          grantReportAccess({ ...input, recipientUserId }),
        ).rejects.toThrow("eligible active recipient");
      for (const senderUserId of [f.ordinary.id, f.outside.id, f.tester.id])
        await expect(
          grantReportAccess({ ...input, senderUserId }),
        ).rejects.toThrow("active administrator");
      const restricted = [
        { mustChangePassword: true },
        { pendingApproval: true },
        { active: false },
        { testingOnly: true },
      ];
      for (const change of restricted) {
        for (const id of [f.admin.id, f.reader.id]) {
          await db.user.update({ where: { id }, data: change });
          await expect(grantReportAccess(input)).rejects.toThrow(
            id === f.admin.id
              ? "active administrator"
              : "eligible active recipient",
          );
          await db.user.update({
            where: { id },
            data: {
              active: true,
              pendingApproval: false,
              testingOnly: false,
              mustChangePassword: false,
            },
          });
        }
      }
      await db.organization.update({
        where: { id: f.org.id },
        data: { status: "SUSPENDED" },
      });
      await expect(grantReportAccess(input)).rejects.toThrow(
        "active administrator",
      );
      expect(
        await db.notification.count({ where: { organizationId: f.org.id } }),
      ).toBe(0);
      expect(
        await db.auditEvent.count({ where: { organizationId: f.org.id } }),
      ).toBe(0);
      expect(
        await db.user.findUniqueOrThrow({
          where: { id: f.reader.id },
          select: { reportAccess: true, role: true },
        }),
      ).toEqual({ reportAccess: false, role: "TECHNICIAN" });
    } finally {
      await f.cleanup();
    }
  });
  it("fails closed on grant retries after revocation or account restriction", async () => {
    const f = await fixture();
    try {
      const input = {
        organizationId: f.org.id,
        senderUserId: f.admin.id,
        recipientUserId: f.reader.id,
        requestId: "synthetic-retry-report-grant-v1",
        authorizationReference: "Synthetic explicit report access approval",
      };
      await grantReportAccess(input);
      for (const change of [
        { reportAccess: false },
        { mustChangePassword: true },
        { pendingApproval: true },
        { active: false },
        { testingOnly: true },
      ]) {
        await db.user.update({ where: { id: f.reader.id }, data: change });
        const before = await db.user.findUniqueOrThrow({
          where: { id: f.reader.id },
        });
        await expect(grantReportAccess(input)).rejects.toThrow(
          "reportAccess" in change ? "revoked" : "eligible active recipient",
        );
        await expect(
          readLabReportContent(f.actor(before), "synthetic-id"),
        ).rejects.toThrow();
        expect(
          await db.user.findUniqueOrThrow({ where: { id: f.reader.id } }),
        ).toEqual(before);
        await db.user.update({
          where: { id: f.reader.id },
          data: {
            reportAccess: true,
            active: true,
            pendingApproval: false,
            testingOnly: false,
            mustChangePassword: false,
          },
        });
      }
      expect(
        await db.notification.count({ where: { organizationId: f.org.id } }),
      ).toBe(1);
      expect(
        await db.auditEvent.count({ where: { organizationId: f.org.id } }),
      ).toBe(2);
    } finally {
      await f.cleanup();
    }
  });
  it("rolls back the grant, notice and audits when the announcement audit fails", async () => {
    const f = await fixture();
    try {
      const input = {
        organizationId: f.org.id,
        senderUserId: f.admin.id,
        recipientUserId: f.reader.id,
        requestId: "synthetic-atomic-report-grant-v1",
        authorizationReference: "Synthetic explicit report access approval",
      };
      const before = await db.user.findUniqueOrThrow({
        where: { id: f.reader.id },
      });
      const record = audit.recordSystemAudit;
      vi.spyOn(audit, "recordSystemAudit")
        .mockImplementationOnce(record)
        .mockRejectedValueOnce(
          new Error("Synthetic announcement audit failure"),
        );
      await expect(grantReportAccess(input)).rejects.toThrow(
        "Synthetic announcement audit failure",
      );
      expect(
        await db.user.findUniqueOrThrow({ where: { id: f.reader.id } }),
      ).toEqual(before);
      expect(
        await db.notification.count({ where: { organizationId: f.org.id } }),
      ).toBe(0);
      expect(
        await db.auditEvent.count({ where: { organizationId: f.org.id } }),
      ).toBe(0);
      expect(await grantReportAccess(input)).toMatchObject({
        created: true,
        granted: true,
        notifiedRecipients: 1,
      });
    } finally {
      await f.cleanup();
    }
  });
});
