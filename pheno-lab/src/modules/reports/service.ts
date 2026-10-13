import "server-only";

import crypto from "node:crypto";
import { db } from "@/infrastructure/db/client";
import { objectStorage } from "@/infrastructure/storage";
import type { Actor } from "@/modules/authorization/actor";
import { recordSystemAudit, recordUserAudit } from "@/modules/audit/writer";
import { notify } from "@/modules/notifications/service";
import { reportContentSecurityPolicy, reportDigest } from "./html";
import { requireReportAccess } from "./query";
import {
  grantReportAccessSchema,
  publishReportSchema,
  reportIdSchema,
} from "./schema";

/** Approved operator publication only. There is no upload or publishing endpoint. */
export async function publishLabReport(raw: unknown) {
  const input = publishReportSchema.parse(raw);
  const recipientIds = [...new Set(input.recipientIds)].sort();
  const body = Buffer.from(input.html, "utf8");
  if (body.byteLength > 2_000_000) throw new Error("Report is too large.");
  const contentSha256 = reportDigest(body);
  const storage = objectStorage();
  let uploadedKey: string | null = null;
  try {
    return await db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`report-publication:${input.organizationId}:${input.publicationKey}`}, 0))`;
        const existing = await tx.labReport.findUnique({
          where: {
            organizationId_publicationKey: {
              organizationId: input.organizationId,
              publicationKey: input.publicationKey,
            },
          },
        });
        if (existing) {
          if (
            existing.contentSha256 !== contentSha256 ||
            existing.titleEn !== input.titleEn ||
            existing.titleZh !== input.titleZh ||
            existing.generatedAt.getTime() !== input.generatedAt.getTime() ||
            JSON.stringify(existing.recipientIds) !==
              JSON.stringify(recipientIds)
          )
            throw new Error(
              "This publication already exists with different content.",
            );
          if (!input.requireExistingAccess)
            return { id: existing.id, created: false, notifiedRecipients: 0 };
        }
        const org = await tx.organization.findFirst({
          where: { id: input.organizationId, status: "ACTIVE" },
          select: { id: true },
        });
        if (!org) throw new Error("An active organization is required.");
        const recipients = await tx.user.findMany({
          where: {
            id: { in: recipientIds },
            organizationId: org.id,
            active: true,
            pendingApproval: false,
            testingOnly: false,
            mustChangePassword: false,
            // Initial publication grants remain managerial. An explicitly
            // pregranted full-access technician may receive recurring reports.
            ...(!input.requireExistingAccess
              ? { role: { in: ["ADMIN" as const, "MANAGER" as const] } }
              : {}),
          },
          select: { id: true, reportAccess: true, language: true },
        });
        if (recipients.length !== recipientIds.length)
          throw new Error(
            input.requireExistingAccess
              ? "Every recipient must be an eligible active account in this organization."
              : "Every recipient must be an active manager in this organization.",
          );
        if (
          input.requireExistingAccess &&
          recipients.some((recipient) => !recipient.reportAccess)
        )
          throw new Error("Every recipient must already have report access.");
        // Recurring publications recheck access even for identical retries.
        if (existing)
          return { id: existing.id, created: false, notifiedRecipients: 0 };
        const id = crypto.randomUUID();
        const storedPath = `organizations/${org.id}/reports/${id}.html`;
        await storage.put({
          key: storedPath,
          body,
          contentType: "text/html; charset=utf-8",
          sha256: contentSha256,
        });
        uploadedKey = storedPath;
        const row = await tx.labReport.create({
          data: {
            id,
            organizationId: org.id,
            publicationKey: input.publicationKey,
            titleEn: input.titleEn,
            titleZh: input.titleZh,
            generatedAt: input.generatedAt,
            storedPath,
            contentSha256,
            contentBytes: body.byteLength,
            recipientIds,
          },
        });
        for (const recipient of recipients) {
          if (input.requireExistingAccess || recipient.reportAccess) continue;
          await tx.user.update({
            where: { id: recipient.id },
            data: { reportAccess: true },
          });
          await recordSystemAudit(tx, {
            organizationId: org.id,
            action: "user.report_access.granted",
            entityType: "User",
            entityId: recipient.id,
            changes: { reportAccess: { before: false, after: true } },
            metadata: { authorizationReference: input.authorizationReference },
          });
        }
        // A system publication notifies every recipient, including its requester.
        await tx.notification.createMany({
          data: recipients.map((recipient) => ({
            organizationId: org.id,
            userId: recipient.id,
            kind: "report_published",
            actorName: "Pheno Lab",
            entityLabel:
              recipient.language === "zh" ? input.titleZh : input.titleEn,
            href: `/reports/${row.id}`,
          })),
        });
        await recordSystemAudit(tx, {
          organizationId: org.id,
          action: "report.published",
          entityType: "LabReport",
          entityId: row.id,
          metadata: {
            contentSha256,
            contentBytes: body.byteLength,
            generatedAt: input.generatedAt.toISOString(),
            notifiedRecipients: recipients.length,
            authorizationReference: input.authorizationReference,
          },
        });
        return {
          id: row.id,
          created: true,
          notifiedRecipients: recipients.length,
        };
      },
      { timeout: 60_000 },
    );
  } catch (error) {
    if (uploadedKey) {
      // Preserve the object if a lost connection leaves commit status uncertain.
      const referenced = await db.labReport
        .findFirst({ where: { storedPath: uploadedKey }, select: { id: true } })
        .catch(() => ({ id: "unknown" }));
      if (!referenced) await storage.delete(uploadedKey).catch(() => undefined);
    }
    throw error;
  }
}

/** Operator-only explicit grant. There is no public permission endpoint. */
export async function grantReportAccess(raw: unknown) {
  const input = grantReportAccessSchema.parse(raw);
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`report-access:${input.organizationId}:${input.recipientUserId}`}, 0))`;
      await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id" = ${input.organizationId} FOR SHARE`;
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "organizationId" = ${input.organizationId} AND ("id" = ${input.senderUserId} OR "id" = ${input.recipientUserId}) ORDER BY "id" FOR UPDATE`;
      const users = await tx.user.findMany({
        where: {
          id: { in: [input.senderUserId, input.recipientUserId] },
          organizationId: input.organizationId,
          active: true,
          pendingApproval: false,
          testingOnly: false,
          mustChangePassword: false,
          organization: { status: "ACTIVE" },
        },
        select: {
          id: true,
          role: true,
          name: true,
          language: true,
          reportAccess: true,
        },
      });
      const sender = users.find((user) => user.id === input.senderUserId);
      const recipient = users.find((user) => user.id === input.recipientUserId);
      if (sender?.role !== "ADMIN")
        throw new Error(
          "An active administrator in this organization is required.",
        );
      if (!recipient)
        throw new Error(
          "An eligible active recipient in this organization is required.",
        );
      const existing = await tx.auditEvent.findFirst({
        where: {
          organizationId: input.organizationId,
          action: "report.access.announced",
          entityType: "User",
          entityId: recipient.id,
          requestId: input.requestId,
        },
        select: { metadata: true },
      });
      if (existing) {
        const metadata = existing.metadata as Record<string, unknown> | null;
        if (
          metadata?.senderUserId !== sender.id ||
          metadata?.approvalReference !== input.authorizationReference
        )
          throw new Error(
            "This report access request already exists with different input.",
          );
        if (!recipient.reportAccess)
          throw new Error(
            "This report access grant was revoked; a retry cannot restore it.",
          );
        return { created: false, granted: false, notifiedRecipients: 0 };
      }
      if (!recipient.reportAccess) {
        await tx.user.update({
          where: { id: recipient.id },
          data: { reportAccess: true },
        });
        await recordSystemAudit(tx, {
          organizationId: input.organizationId,
          action: "user.report_access.granted",
          entityType: "User",
          entityId: recipient.id,
          requestId: input.requestId,
          changes: { reportAccess: { before: false, after: true } },
          metadata: {
            senderUserId: sender.id,
            approvalReference: input.authorizationReference,
          },
        });
      }
      await notify(tx, {
        organizationId: input.organizationId,
        userId: recipient.id,
        actorUserId: sender.id,
        actorName: sender.name,
        kind: "report_access_granted",
        entityLabel:
          recipient.language === "zh"
            ? "Pheno Lab 研究报告"
            : "Pheno Lab research reports",
        href: "/reports",
      });
      await recordSystemAudit(tx, {
        organizationId: input.organizationId,
        action: "report.access.announced",
        entityType: "User",
        entityId: recipient.id,
        requestId: input.requestId,
        metadata: {
          senderUserId: sender.id,
          approvalReference: input.authorizationReference,
          kind: "report_access_granted",
        },
      });
      return {
        created: true,
        granted: !recipient.reportAccess,
        notifiedRecipients: 1,
      };
    },
    { isolationLevel: "Serializable" },
  );
}

export async function readLabReportContent(actor: Actor, rawId: unknown) {
  const id = reportIdSchema.parse(rawId);
  await requireReportAccess(actor);
  const row = await db.labReport.findFirst({
    where: { id, organizationId: actor.org },
  });
  if (!row) return null;
  if (!row.storedPath.startsWith(`organizations/${actor.org}/reports/`))
    throw new Error("Invalid report storage scope.");
  const body = await objectStorage().get(row.storedPath);
  if (!body) throw new Error("Report content is unavailable.");
  if (
    body.byteLength !== row.contentBytes ||
    reportDigest(body) !== row.contentSha256
  )
    throw new Error("Report integrity check failed.");
  await recordUserAudit(db, {
    actor,
    action: "report.content.read",
    entityType: "LabReport",
    entityId: row.id,
  });
  return {
    body,
    contentSecurityPolicy: reportContentSecurityPolicy(
      Buffer.from(body).toString("utf8"),
    ),
  };
}
