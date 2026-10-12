import "server-only";

import crypto from "node:crypto";
import { z } from "zod";
import { db } from "@/infrastructure/db/client";
import { recordSystemAudit } from "@/modules/audit/writer";
import { notify } from "@/modules/notifications/service";
import { chemicalRowDigest, requireChemicalAccess } from "./query";
import { readChemicalStructure } from "./service";

const registrySchema = z.object({
  organizationId: z.string().trim().min(1).max(200),
  actorUserId: z.string().trim().min(1).max(200),
  referenceMaterialId: z.string().trim().min(1).max(200),
  expectedDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expectedStructureSha256: z.string().regex(/^[a-f0-9]{64}$/),
  authorizationReference: z.string().trim().min(5).max(500),
});

/** Explicitly approved portal reset; leaves all scientific source data intact. */
export async function initializeSamRegistry(raw: unknown) {
  const input = registrySchema.parse(raw);
  const user = await db.user.findFirstOrThrow({
    where: { id: input.actorUserId, organizationId: input.organizationId },
    select: { id: true, role: true },
  });
  const actor = { uid: user.id, org: input.organizationId, role: user.role };
  const structure = await readChemicalStructure(
    actor,
    input.referenceMaterialId,
  );
  if (
    !structure ||
    crypto.createHash("sha256").update(structure).digest("hex") !==
      input.expectedStructureSha256
  )
    throw new Error("A verified saved reference structure is required.");
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`chemical-save:${actor.org}`},0))`;
    await requireChemicalAccess(actor, tx);
    await tx.$queryRaw`SELECT "id" FROM "Material" WHERE "id" = ${input.referenceMaterialId} AND "organizationId" = ${actor.org} FOR UPDATE`;
    const reference = await tx.material.findFirst({
      where: {
        id: input.referenceMaterialId,
        organizationId: actor.org,
        archived: false,
        category: "SAM",
      },
      include: { chemistry: true },
    });
    if (
      !reference?.chemistry ||
      chemicalRowDigest(reference) !== input.expectedDigest ||
      reference.chemistry.structureSha256 !== input.expectedStructureSha256 ||
      reference.chemistry.inputSha256 !==
        crypto.createHash("sha256").update(reference.smiles).digest("hex")
    )
      throw new Error("Reference changed; review the current definition.");
    const others = await tx.materialChemistry.count({
      where: {
        inSamRegistry: true,
        material: { organizationId: actor.org },
        materialId: { not: reference.id },
      },
    });
    if (reference.chemistry.inSamRegistry && !others)
      return { changed: false, visible: 1 };
    await tx.materialChemistry.updateMany({
      where: { inSamRegistry: true, material: { organizationId: actor.org } },
      data: { inSamRegistry: false },
    });
    await tx.materialChemistry.update({
      where: { materialId: reference.id },
      data: { inSamRegistry: true },
    });
    await recordSystemAudit(tx, {
      organizationId: actor.org,
      action: "chemistry.sam_registry.initialized",
      entityType: "Material",
      entityId: reference.id,
      changes: { visible: 1, removedFromPortal: others },
      metadata: {
        authorizationReference: input.authorizationReference,
        sourceDataPreserved: true,
      },
    });
    return { changed: true, visible: 1 };
  });
}

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
