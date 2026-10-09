import "server-only";

import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { db } from "@/infrastructure/db/client";
import {
  encryptCredential,
  decryptCredential,
} from "@/infrastructure/crypto/credential-server";
import { isEncryptedCredential } from "@/infrastructure/crypto/credential";
import type { Actor } from "@/modules/authorization/actor";
import { assertFullAccess } from "@/modules/authorization/policy";
import { recordSystemAudit, recordUserAudit } from "@/modules/audit/writer";
import { emailSchema } from "./schema";

const provisionSchema = z.object({
  organizationId: z.string().min(1).max(128),
  name: z.string().trim().min(1).max(200),
  email: emailSchema,
  recipientIds: z.array(z.string().min(1).max(128)).min(1).max(5),
  authorizationReference: z.string().trim().min(1).max(500),
});

/** Operator-only, explicitly approved provisioning; deliberately no HTTP/Action entry point. */
export async function provisionTestingAccount(raw: unknown) {
  const input = provisionSchema.parse(raw);
  const recipientIds = [...new Set(input.recipientIds)];
  const password = crypto.randomBytes(18).toString("base64url");
  const passwordHash = await bcrypt.hash(password, 10);
  const encryptedPassword = encryptCredential(password);
  const expiresAt = new Date(Date.now() + 7 * 24 * 3600_000);
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`account-provision:${input.organizationId}`}, 0))`;
    const org = await tx.organization.findFirst({
      where: {
        id: input.organizationId,
        status: "ACTIVE",
        emailDomains: { has: input.email.split("@")[1] },
      },
      select: { id: true },
    });
    if (!org)
      throw new Error("Active organization and allowed email domain required.");
    const recipients = await tx.user.findMany({
      where: {
        id: { in: recipientIds },
        organizationId: org.id,
        active: true,
        pendingApproval: false,
        testingOnly: false,
        OR: [{ role: "ADMIN" }, { memberAdmin: true }],
      },
      select: { id: true },
    });
    if (recipients.length !== recipientIds.length)
      throw new Error(
        "Handoff recipients must be active member administrators in this organization.",
      );
    if (
      await tx.user.findUnique({
        where: { email: input.email },
        select: { id: true },
      })
    )
      throw new Error(
        "An account already exists; provisioning never overwrites it.",
      );
    const max = await tx.user.aggregate({
      where: { organizationId: org.id },
      _max: { userNumber: true },
    });
    const user = await tx.user.create({
      data: {
        organizationId: org.id,
        name: input.name,
        email: input.email,
        passwordHash,
        userNumber: (max._max.userNumber ?? 0) + 1,
        role: "TECHNICIAN",
        testingOnly: true,
        mustChangePassword: true,
        temporaryPasswordExpiresAt: expiresAt,
      },
    });
    const handoff = await tx.accountHandoff.create({
      data: {
        organizationId: org.id,
        targetUserId: user.id,
        recipientIds,
        encryptedPassword,
        expiresAt,
      },
    });
    await tx.notification.createMany({
      data: recipientIds.map((userId) => ({
        organizationId: org.id,
        userId,
        kind: "account_setup_ready",
        actorName: "Pheno Lab",
        entityLabel: user.name,
        href: `/account-handoffs/${handoff.id}`,
      })),
    });
    await recordSystemAudit(tx, {
      organizationId: org.id,
      action: "user.testing_account.provisioned",
      entityType: "User",
      entityId: user.id,
      changes: {
        role: "TECHNICIAN",
        testingOnly: true,
        mustChangePassword: true,
      },
      metadata: {
        authorizationReference: input.authorizationReference,
        notifiedRecipients: recipientIds.length,
      },
    });
    return {
      userId: user.id,
      email: user.email,
      handoffId: handoff.id,
      expiresAt: expiresAt.toISOString(),
      notifiedRecipients: recipientIds.length,
    };
  });
}

async function authorizedHandoff(actor: Actor, id: string) {
  assertFullAccess(actor);
  const user = await db.user.findFirst({
    where: {
      id: actor.uid,
      organizationId: actor.org,
      active: true,
      pendingApproval: false,
      testingOnly: false,
      mustChangePassword: false,
      OR: [{ role: "ADMIN" }, { memberAdmin: true }],
    },
    select: { id: true },
  });
  if (!user) throw new Error("Handoff unavailable.");
  const row = await db.accountHandoff.findFirst({
    where: { id, organizationId: actor.org, recipientIds: { has: actor.uid } },
    include: {
      targetUser: {
        select: {
          name: true,
          email: true,
          active: true,
          mustChangePassword: true,
        },
      },
    },
  });
  if (!row) throw new Error("Handoff unavailable.");
  return row;
}

export async function getAccountHandoff(actor: Actor, id: string) {
  const row = await authorizedHandoff(actor, id);
  return {
    name: row.targetUser.name,
    email: row.targetUser.email,
    expiresAt: row.expiresAt.toISOString(),
    available:
      !row.revokedAt &&
      row.expiresAt.getTime() > Date.now() &&
      row.targetUser.active &&
      row.targetUser.mustChangePassword &&
      isEncryptedCredential(row.encryptedPassword),
  };
}

/** Secret is fetched explicitly, never in a notification list or prefetched page payload. */
export async function revealAccountHandoff(actor: Actor, id: string) {
  const row = await authorizedHandoff(actor, id);
  if (
    row.revokedAt ||
    row.expiresAt.getTime() <= Date.now() ||
    !row.targetUser.active ||
    !row.targetUser.mustChangePassword ||
    !isEncryptedCredential(row.encryptedPassword)
  )
    throw new Error("Temporary credentials are no longer available.");
  await recordUserAudit(db, {
    actor,
    action: "user.account_handoff.viewed",
    entityType: "User",
    entityId: row.targetUserId,
  });
  return decryptCredential(row.encryptedPassword);
}
