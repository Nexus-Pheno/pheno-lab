import "server-only";

import { z } from "zod";
import { db } from "@/infrastructure/db/client";
import { recordSystemAudit } from "@/modules/audit/writer";
import { notify } from "@/modules/notifications/service";
import { requireChemicalAccess } from "./query";

const grantSchema = z.object({
  organizationId: z.string().trim().min(1).max(200),
  recipientIds: z
    .array(z.string().trim().min(1).max(200))
    .length(2)
    .refine((ids) => new Set(ids).size === 2),
  authorizationReference: z.string().trim().min(5).max(500),
});

/** Operator-only approved provisioning. Never exposed as an application action. */
export async function grantChemicalAccess(raw: unknown) {
  const input = grantSchema.parse(raw);
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`chemical-grants:${input.organizationId}`},0))`;
      const users = await tx.user.findMany({
        where: {
          id: { in: input.recipientIds },
          organizationId: input.organizationId,
          active: true,
          pendingApproval: false,
          testingOnly: false,
          mustChangePassword: false,
          role: { in: ["ADMIN", "MANAGER"] },
          organization: { status: "ACTIVE" },
        },
        select: { id: true, chemicalAccess: true },
      });
      if (users.length !== 2)
        throw new Error(
          "Exactly two approved, active chemistry maintainers are required.",
        );
      const other = await tx.user.count({
        where: {
          organizationId: input.organizationId,
          chemicalAccess: true,
          id: { notIn: input.recipientIds },
        },
      });
      if (other)
        throw new Error(
          "Unexpected existing chemistry grants require human review.",
        );
      let granted = 0;
      for (const user of users) {
        if (user.chemicalAccess) continue;
        await tx.user.update({
          where: { id: user.id },
          data: { chemicalAccess: true },
        });
        await recordSystemAudit(tx, {
          organizationId: input.organizationId,
          action: "user.chemical_access.granted",
          entityType: "User",
          entityId: user.id,
          changes: { chemicalAccess: true },
          metadata: { authorizationReference: input.authorizationReference },
        });
        granted++;
      }
      return { granted, unchanged: 2 - granted };
    },
    { isolationLevel: "Serializable" },
  );
}

const announcementSchema = z
  .object({
    organizationId: z.string().trim().min(1).max(200),
    senderUserId: z.string().trim().min(1).max(200),
    recipientUserId: z.string().trim().min(1).max(200),
    authorizationReference: z.string().trim().min(5).max(500),
  })
  .refine((input) => input.senderUserId !== input.recipientUserId);

/** Explicit operator announcement; never grants access or sends external messages. */
export async function announceChemicalPortal(raw: unknown) {
  const input = announcementSchema.parse(raw);
  return db.$transaction(async (tx) => {
    const requestId = "chemicals-portal-ready-v1";
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${requestId}:${input.organizationId}:${input.recipientUserId}`},0))`;
    const users = await tx.user.findMany({
      where: {
        id: { in: [input.senderUserId, input.recipientUserId] },
        organizationId: input.organizationId,
      },
      select: { id: true, name: true, role: true },
    });
    const sender = users.find((user) => user.id === input.senderUserId);
    const recipient = users.find((user) => user.id === input.recipientUserId);
    if (!sender || !recipient)
      throw new Error("Approved scoped identities are required.");
    for (const user of [sender, recipient])
      await requireChemicalAccess(
        { uid: user.id, org: input.organizationId, role: user.role },
        tx,
      );
    const existing = await tx.auditEvent.findFirst({
      where: {
        organizationId: input.organizationId,
        action: "chemistry.portal.announced",
        entityId: recipient.id,
        requestId,
      },
      select: { id: true },
    });
    if (existing) return { created: false };
    await notify(tx, {
      organizationId: input.organizationId,
      userId: recipient.id,
      actorUserId: sender.id,
      actorName: sender.name,
      kind: "chemicals_ready",
      entityLabel: "Pheno Chemicals",
      href: "/chemicals",
    });
    await recordSystemAudit(tx, {
      organizationId: input.organizationId,
      action: "chemistry.portal.announced",
      entityType: "User",
      entityId: recipient.id,
      requestId,
      metadata: {
        authorizationReference: input.authorizationReference,
        kind: "chemicals_ready",
      },
    });
    return { created: true };
  });
}
