"use server";

import crypto from "crypto";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";

// Organization onboarding: the platform admin (admin of org #1) sends an
// invite link; a representative registers their organization + designated
// admin on /onboard; the platform admin approves it from /organizations.

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function requirePlatformAdmin() {
  const session = await requireAdmin();
  const org = await db.organization.findUnique({ where: { id: session.org } });
  if (!org || org.orgNumber !== 1) throw new Error("Only the platform operator can manage organizations.");
  return session;
}

export async function isPlatformAdmin(): Promise<boolean> {
  try {
    await requirePlatformAdmin();
    return true;
  } catch {
    return false;
  }
}

export async function createOrgInvite(): Promise<{ token: string }> {
  await requirePlatformAdmin();
  const token = crypto.randomBytes(24).toString("base64url");
  await db.orgInvite.create({ data: { token, expiresAt: new Date(Date.now() + INVITE_TTL_MS) } });
  return { token };
}

export async function approveOrganization(orgId: string) {
  await requirePlatformAdmin();
  await db.organization.update({ where: { id: orgId }, data: { status: "ACTIVE" } });
  await db.user.updateMany({ where: { organizationId: orgId }, data: { active: true } });
}

/** Reject a pending submission — removes the organization and its (inactive)
 * designated admin. Active organizations are never deleted here. */
export async function rejectOrganization(orgId: string) {
  await requirePlatformAdmin();
  const org = await db.organization.findUniqueOrThrow({ where: { id: orgId } });
  if (org.status !== "PENDING") throw new Error("Only pending organizations can be rejected.");
  await db.user.deleteMany({ where: { organizationId: orgId } });
  await db.organization.delete({ where: { id: orgId } });
}

export async function saveOrgDomains(orgId: string, domainsCsv: string) {
  await requirePlatformAdmin();
  const domains = [...new Set(
    domainsCsv.split(/[,，、;；\s]+/).map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean)
  )];
  await db.organization.update({ where: { id: orgId }, data: { emailDomains: domains } });
}

/** Org admins rename their own organization. */
export async function renameOwnOrganization(name: string) {
  const session = await requireAdmin();
  if (!name.trim()) throw new Error("Organization name is required.");
  await db.organization.update({ where: { id: session.org }, data: { name: name.trim() } });
}

// ---- Public (token-gated) onboarding ----

export async function checkInvite(token: string): Promise<{ valid: boolean }> {
  const invite = await db.orgInvite.findUnique({ where: { token } });
  return { valid: !!invite && !invite.usedAt && invite.expiresAt > new Date() };
}

export async function submitOrganization(data: {
  token: string;
  orgName: string;
  domainsCsv: string;
  adminName: string;
  adminEmail: string;
  password: string;
}): Promise<{ ok: boolean; error?: string }> {
  const invite = await db.orgInvite.findUnique({ where: { token: data.token } });
  if (!invite || invite.usedAt || invite.expiresAt < new Date()) return { ok: false, error: "bad-token" };

  const email = data.adminEmail.trim().toLowerCase();
  const name = data.orgName.trim();
  const domains = [...new Set(
    data.domainsCsv.split(/[,，、;；\s]+/).map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean)
  )];
  if (!name || domains.length === 0) return { ok: false, error: "bad-input" };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: "bad-input" };
  if (data.password.length < 8) return { ok: false, error: "bad-input" };
  if (!domains.includes(email.split("@")[1])) return { ok: false, error: "email-domain" };
  if (await db.user.findUnique({ where: { email } })) return { ok: false, error: "exists" };

  const slugBase = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "org";
  const passwordHash = await bcrypt.hash(data.password, 10);

  await db.$transaction(async (tx) => {
    const maxNo = await tx.organization.aggregate({ _max: { orgNumber: true } });
    let slug = slugBase;
    for (let i = 2; await tx.organization.findUnique({ where: { slug } }); i++) slug = `${slugBase}-${i}`;
    const org = await tx.organization.create({
      data: {
        name,
        slug,
        orgNumber: (maxNo._max.orgNumber ?? 0) + 1,
        emailDomains: domains,
        status: "PENDING",
      },
    });
    // The designated admin — inactive until the platform admin approves.
    await tx.user.create({
      data: {
        organizationId: org.id,
        email,
        name: data.adminName.trim() || email.split("@")[0],
        passwordHash,
        userNumber: 1,
        role: "ADMIN",
        active: false,
      },
    });
    await tx.orgInvite.update({ where: { id: invite.id }, data: { usedAt: new Date() } });
  });
  return { ok: true };
}
