import "server-only";

import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { db } from "@/infrastructure/db/client";
import type { Actor } from "@/modules/authorization/actor";
import { assertAdmin } from "@/modules/authorization/policy";
import { recordUserAudit } from "@/modules/audit/writer";
import {
  inviteTokenSchema,
  organizationNameSchema,
  organizationSubmissionSchema,
} from "@/modules/accounts/schema";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const idSchema = z.string().min(1).max(128);

function parseDomains(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,，、;；\s]+/)
        .map((domain) => domain.trim().toLowerCase().replace(/^@/, ""))
        .filter(Boolean),
    ),
  ];
}

export async function assertPlatformAdmin(actor: Actor): Promise<void> {
  assertAdmin(actor);
  const organization = await db.organization.findFirst({
    where: { id: actor.org, orgNumber: 1, status: "ACTIVE" },
    select: { id: true },
  });
  if (!organization) {
    throw new Error("Only the platform operator can manage organizations.");
  }
}

export async function isPlatformAdmin(actor: Actor): Promise<boolean> {
  try {
    await assertPlatformAdmin(actor);
    return true;
  } catch {
    return false;
  }
}

export async function createOrgInvite(actor: Actor) {
  await assertPlatformAdmin(actor);
  const token = crypto.randomBytes(24).toString("base64url");
  await db.$transaction(async (tx) => {
    const row = await tx.orgInvite.create({
      data: { token, expiresAt: new Date(Date.now() + INVITE_TTL_MS) },
    });
    await recordUserAudit(tx, {
      actor,
      action: "organization.invite.created",
      entityType: "OrgInvite",
      entityId: row.id,
      metadata: { expiresAt: row.expiresAt.toISOString() },
    });
  });
  return { token };
}

export async function approveOrganization(actor: Actor, rawOrgId: unknown) {
  await assertPlatformAdmin(actor);
  const orgId = idSchema.parse(rawOrgId);
  await db.$transaction(async (tx) => {
    const result = await tx.organization.updateMany({
      where: { id: orgId, status: "PENDING" },
      data: { status: "ACTIVE" },
    });
    if (result.count !== 1) throw new Error("Pending organization not found.");
    await tx.user.updateMany({
      where: { organizationId: orgId },
      data: { active: true },
    });
    await recordUserAudit(tx, {
      actor,
      action: "organization.approved",
      entityType: "Organization",
      entityId: orgId,
    });
  });
}

export async function rejectOrganization(actor: Actor, rawOrgId: unknown) {
  await assertPlatformAdmin(actor);
  const orgId = idSchema.parse(rawOrgId);
  await db.$transaction(async (tx) => {
    const organization = await tx.organization.findFirst({
      where: { id: orgId, status: "PENDING" },
      select: { id: true, name: true },
    });
    if (!organization) throw new Error("Pending organization not found.");
    await recordUserAudit(tx, {
      actor,
      action: "organization.rejected",
      entityType: "Organization",
      entityId: orgId,
      changes: { name: organization.name },
    });
    await tx.user.deleteMany({ where: { organizationId: orgId } });
    await tx.organization.delete({ where: { id: orgId } });
  });
}

export async function saveOrgDomains(
  actor: Actor,
  rawOrgId: unknown,
  rawDomains: unknown,
) {
  await assertPlatformAdmin(actor);
  const orgId = idSchema.parse(rawOrgId);
  const domains = parseDomains(z.string().max(5_000).parse(rawDomains));
  await db.$transaction(async (tx) => {
    await tx.organization.update({
      where: { id: orgId },
      data: { emailDomains: domains },
    });
    await recordUserAudit(tx, {
      actor,
      action: "organization.email-domains.updated",
      entityType: "Organization",
      entityId: orgId,
      changes: { emailDomains: domains },
    });
  });
}

export async function renameOwnOrganization(actor: Actor, rawName: unknown) {
  assertAdmin(actor);
  const name = organizationNameSchema.parse(rawName);
  await db.$transaction(async (tx) => {
    await tx.organization.update({
      where: { id: actor.org },
      data: { name },
    });
    await recordUserAudit(tx, {
      actor,
      action: "organization.renamed",
      entityType: "Organization",
      entityId: actor.org,
      changes: { name },
    });
  });
}

export async function checkInvite(rawToken: unknown) {
  const token = inviteTokenSchema.parse(rawToken);
  const invite = await db.orgInvite.findFirst({
    where: { token, usedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true },
  });
  return { valid: Boolean(invite) };
}

export async function submitOrganization(
  raw: unknown,
): Promise<{ ok: boolean; error?: string }> {
  const parsed = organizationSubmissionSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "bad-input" };
  const input = parsed.data;
  const domains = parseDomains(input.domainsCsv);
  if (!domains.length) return { ok: false, error: "bad-input" };
  if (!domains.includes(input.adminEmail.split("@")[1])) {
    return { ok: false, error: "email-domain" };
  }
  if (await db.user.findUnique({ where: { email: input.adminEmail } })) {
    return { ok: false, error: "exists" };
  }

  const slugBase =
    input.orgName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "org";
  const passwordHash = await bcrypt.hash(input.password, 10);

  try {
    await db.$transaction(async (tx) => {
      const consumed = await tx.orgInvite.updateMany({
        where: {
          token: input.token,
          usedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { usedAt: new Date() },
      });
      if (consumed.count !== 1) throw new Error("bad-token");
      const maximum = await tx.organization.aggregate({
        _max: { orgNumber: true },
      });
      let slug = slugBase;
      for (
        let index = 2;
        await tx.organization.findUnique({ where: { slug } });
        index += 1
      ) {
        slug = `${slugBase}-${index}`;
      }
      const organization = await tx.organization.create({
        data: {
          name: input.orgName,
          slug,
          orgNumber: (maximum._max.orgNumber ?? 0) + 1,
          emailDomains: domains,
          status: "PENDING",
        },
      });
      const user = await tx.user.create({
        data: {
          organizationId: organization.id,
          email: input.adminEmail,
          name: input.adminName || input.adminEmail.split("@")[0],
          passwordHash,
          userNumber: 1,
          role: "ADMIN",
          active: false,
        },
      });
      await tx.auditEvent.create({
        data: {
          organizationId: organization.id,
          actorType: "SYSTEM",
          action: "organization.submitted",
          entityType: "Organization",
          entityId: organization.id,
          metadata: { adminUserId: user.id },
        },
      });
    });
  } catch (error) {
    if (error instanceof Error && error.message === "bad-token") {
      return { ok: false, error: "bad-token" };
    }
    throw error;
  }
  return { ok: true };
}
