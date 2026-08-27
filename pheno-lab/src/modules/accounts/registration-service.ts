import "server-only";

import type { Prisma } from "@prisma/client";

import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { db } from "@/infrastructure/db/client";
import { nameKey } from "@/lib/name-match";
import {
  isMailConfigured,
  sendMail,
  otpEmail,
} from "@/infrastructure/mail/mailer";
import {
  createUserSchema,
  emailSchema,
  registrationSchema,
  roleSchema,
} from "@/modules/accounts/schema";
import { entityIdSchema } from "@/modules/runs/schema";
import { recordUserAudit } from "@/modules/audit/writer";
import { log } from "@/infrastructure/logging/logger";
import type { Actor } from "@/modules/authorization/actor";
import { assertAdmin } from "@/modules/authorization/policy";

// Registration is OTP-based and restricted to an organization's email
// domains. Codes are emailed via SMTP when configured; the admin's Users
// page always shows pending codes as a fallback channel.

const CODE_TTL_MS = 15 * 60 * 1000;

function orgForEmail(email: string) {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return null;
  return db.organization.findFirst({
    where: { emailDomains: { has: domain }, status: "ACTIVE" },
  });
}

export async function requestRegistration(
  emailRaw: string,
): Promise<{ ok: boolean; error?: string; emailed?: boolean }> {
  const parsedEmail = emailSchema.safeParse(emailRaw);
  if (!parsedEmail.success) return { ok: false, error: "bad-domain" };
  const email = parsedEmail.data;

  const existing = await db.user.findUnique({ where: { email } });
  if (existing) return { ok: false, error: "exists" };

  const org = await orgForEmail(email);
  if (!org) return { ok: false, error: "bad-domain" };

  const code = crypto.randomInt(100000, 999999).toString();
  // Replacing prior codes is atomic, so concurrent requests never leave an
  // accidental mix of old and new valid codes.
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`registration:${email}`}, 0))`;
    await tx.otpCode.deleteMany({ where: { email, usedAt: null } });
    await tx.otpCode.create({
      data: {
        organizationId: org.id,
        email,
        code,
        purpose: "register",
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
      },
    });
  });
  // Primary delivery is SMTP. The admin's Users page is the fallback channel;
  // OTPs are deliberately never written to stdout/journald.
  if (isMailConfigured()) {
    try {
      const m = otpEmail(code);
      await sendMail(email, m.subject, m.text, m.html);
      return { ok: true, emailed: true };
    } catch (error) {
      log.error("registration.smtp_failed", {
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
  return { ok: true, emailed: false };
}

/**
 * The inactive placeholder account the legacy import created for this
 * person's folder name, if one matches. Claiming it (instead of creating a
 * fresh user) makes all their imported experiments theirs the moment the
 * account exists — no ownership rewriting.
 */
async function claimableLegacyUser(
  tx: Prisma.TransactionClient,
  organizationId: string,
  name: string,
) {
  const placeholders = await tx.user.findMany({
    where: {
      organizationId,
      active: false,
      passwordHash: "",
      email: { contains: "@imported." },
    },
  });
  return placeholders.find((u) => nameKey(u.name) === nameKey(name)) ?? null;
}

export async function verifyRegistration(data: {
  email: string;
  code: string;
  name: string;
  password: string;
}): Promise<{ ok: boolean; error?: string }> {
  const parsed = registrationSchema.safeParse(data);
  if (!parsed.success) return { ok: false, error: "bad-code" };
  const clean = parsed.data;
  const email = clean.email;
  const otp = await db.otpCode.findFirst({
    where: {
      email,
      code: clean.code,
      purpose: "register",
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
  });
  if (!otp) return { ok: false, error: "bad-code" };
  if (await db.user.findUnique({ where: { email } }))
    return { ok: false, error: "exists" };

  const passwordHash = await bcrypt.hash(clean.password, 10);
  await db.$transaction(async (tx) => {
    await tx.otpCode.update({
      where: { id: otp.id },
      data: { usedAt: new Date() },
    });
    // Each user gets the next sequential number in their organization —
    // it becomes part of every experiment code they create.
    const max = await tx.user.aggregate({
      where: { organizationId: otp.organizationId },
      _max: { userNumber: true },
    });
    const isFirstUser = max._max.userNumber === null;
    const registeredName = clean.name || email.split("@")[0];
    const legacy = await claimableLegacyUser(
      tx,
      otp.organizationId,
      registeredName,
    );
    const user = legacy
      ? // Claim the imported placeholder: its userNumber and every
        // experiment it owns carry over untouched.
        await tx.user.update({
          where: { id: legacy.id },
          data: { email, name: registeredName, passwordHash, active: true },
        })
      : await tx.user.create({
          data: {
            organizationId: otp.organizationId,
            email,
            name: registeredName,
            passwordHash,
            userNumber: (max._max.userNumber ?? 0) + 1,
            // First member of an organization becomes its designated admin;
            // everyone after starts as technician and is promoted by the admin.
            role: isFirstUser ? "ADMIN" : "TECHNICIAN",
          },
        });
    await tx.auditEvent.create({
      data: {
        organizationId: otp.organizationId,
        actorType: "SYSTEM",
        action: "user.register",
        entityType: "User",
        entityId: user.id,
        metadata: legacy
          ? {
              role: user.role,
              claimedLegacyUser: legacy.id,
              legacyName: legacy.name,
            }
          : { role: user.role },
      },
    });
  });
  return { ok: true };
}

// ---- Admin: user management ----

/** Admin creates an account directly (email + password), skipping OTP —
 * for colleagues who can't receive the passcode email yet. */
export async function createUserAccount(
  data: {
    name: string;
    email: string;
    password: string;
    role: "ADMIN" | "MANAGER" | "TECHNICIAN";
  },
  actor: Actor,
): Promise<{ ok: boolean; error?: string }> {
  assertAdmin(actor);
  const parsed = createUserSchema.safeParse(data);
  if (!parsed.success) return { ok: false, error: "bad-input" };
  const clean = parsed.data;
  const email = clean.email;
  if (await db.user.findUnique({ where: { email } }))
    return { ok: false, error: "exists" };

  const passwordHash = await bcrypt.hash(clean.password, 10);
  await db.$transaction(async (tx) => {
    const max = await tx.user.aggregate({
      where: { organizationId: actor.org },
      _max: { userNumber: true },
    });
    const createdName = clean.name || email.split("@")[0];
    const legacy = await claimableLegacyUser(tx, actor.org, createdName);
    const user = legacy
      ? await tx.user.update({
          where: { id: legacy.id },
          data: {
            email,
            name: createdName,
            passwordHash,
            active: true,
            role: clean.role,
          },
        })
      : await tx.user.create({
          data: {
            organizationId: actor.org,
            email,
            name: createdName,
            passwordHash,
            userNumber: (max._max.userNumber ?? 0) + 1,
            role: clean.role,
          },
        });
    await recordUserAudit(tx, {
      actor,
      action: "user.create",
      entityType: "User",
      entityId: user.id,
      changes: legacy
        ? { email, role: clean.role, claimedLegacyUser: legacy.id }
        : { email, role: clean.role },
    });
  });
  return { ok: true };
}

export async function setUserRole(
  actor: Actor,
  userId: string,
  role: "ADMIN" | "MANAGER" | "TECHNICIAN",
) {
  assertAdmin(actor);
  const id = entityIdSchema.parse(userId);
  const nextRole = roleSchema.parse(role);
  if (id === actor.uid) throw new Error("You cannot change your own role.");
  await db.$transaction(async (tx) => {
    const updated = await tx.user.updateMany({
      where: { id, organizationId: actor.org },
      data: { role: nextRole },
    });
    if (updated.count !== 1) throw new Error("User not found.");
    await recordUserAudit(tx, {
      actor,
      action: "user.role.update",
      entityType: "User",
      entityId: id,
      changes: { role: nextRole },
    });
  });
}

export async function setUserActive(
  actor: Actor,
  userId: string,
  active: boolean,
) {
  assertAdmin(actor);
  const id = entityIdSchema.parse(userId);
  if (id === actor.uid) throw new Error("You cannot deactivate yourself.");
  await db.$transaction(async (tx) => {
    const updated = await tx.user.updateMany({
      where: { id, organizationId: actor.org },
      data: { active },
    });
    if (updated.count !== 1) throw new Error("User not found.");
    await recordUserAudit(tx, {
      actor,
      action: "user.active.update",
      entityType: "User",
      entityId: id,
      changes: { active },
    });
  });
}

export async function setEmailDomains(actor: Actor, domainsCsv: string) {
  assertAdmin(actor);
  if (domainsCsv.length > 5_000) throw new Error("Domain list is too long.");
  // Split on ASCII and CJK separators alike (，、；;) — a full-width comma
  // once glued two domains into one unmatched entry.
  const domains = [
    ...new Set(
      domainsCsv
        .split(/[,，、;；\s]+/)
        .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
        .filter(Boolean),
    ),
  ];
  await db.$transaction(async (tx) => {
    await tx.organization.update({
      where: { id: actor.org },
      data: { emailDomains: domains },
    });
    await recordUserAudit(tx, {
      actor,
      action: "organization.email-domains.update",
      entityType: "Organization",
      entityId: actor.org,
      changes: { emailDomains: domains },
    });
  });
}
