import "server-only";

import crypto from "node:crypto";
import { db } from "@/infrastructure/db/client";
import { objectStorage } from "@/infrastructure/storage";
import type { Actor } from "@/modules/authorization/actor";
import { recordSystemAudit, recordUserAudit } from "@/modules/audit/writer";
import { reportContentSecurityPolicy, reportDigest } from "./html";
import { requireReportAccess } from "./query";
import { publishReportSchema, reportIdSchema } from "./schema";

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
            role: { in: ["ADMIN", "MANAGER"] },
          },
          select: { id: true, reportAccess: true, language: true },
        });
        if (recipients.length !== recipientIds.length)
          throw new Error(
            "Every recipient must be an active manager in this organization.",
          );
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
          if (recipient.reportAccess) continue;
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
