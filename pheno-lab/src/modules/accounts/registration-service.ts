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
  registrationApprovalSchema,
  userIdentitySchema,
} from "@/modules/accounts/schema";
import { entityIdSchema } from "@/modules/runs/schema";
import { recordUserAudit } from "@/modules/audit/writer";
import { log } from "@/infrastructure/logging/logger";
import { sendGroupNotice } from "@/modules/notifications/group-service";
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
  const pendingApproval = await db.$transaction(async (tx) => {
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
    // Registrations wait for the admin, who fixes the name/email styling and
    // may claim a legacy dataset during approval (Michael, 2026-09-07). The
    // organization's very first member self-approves — there is no admin yet.
    const user = await tx.user.create({
      data: {
        organizationId: otp.organizationId,
        email,
        name: registeredName,
        passwordHash,
        userNumber: (max._max.userNumber ?? 0) + 1,
        role: isFirstUser ? "ADMIN" : "TECHNICIAN",
        active: isFirstUser,
        pendingApproval: !isFirstUser,
      },
    });
    await tx.auditEvent.create({
      data: {
        organizationId: otp.organizationId,
        actorType: "SYSTEM",
        action: "user.register",
        entityType: "User",
        entityId: user.id,
        metadata: { role: user.role, pendingApproval: user.pendingApproval },
      },
    });
    return user.pendingApproval;
  });
  if (pendingApproval)
    await sendGroupNotice(otp.organizationId, "registration_pending");
  return { ok: true };
}

// ---- Admin: registration approval ----

export type RegistrationApproval = {
  id: string;
  name: string;
  handle: string;
  email: string;
  createdAt: string;
  /** nameKey-matched placeholder, preselected in the approval form. */
  suggestedLegacyId: string | null;
};

export type LegacyOption = {
  id: string;
  name: string;
  experiments: number;
};

/** Pending self-registrations plus the claimable legacy datasets. */
export async function listRegistrationApprovals(actor: Actor): Promise<{
  approvals: RegistrationApproval[];
  legacyOptions: LegacyOption[];
}> {
  assertAdmin(actor);
  const [pendingUsers, placeholders] = await Promise.all([
    db.user.findMany({
      where: { organizationId: actor.org, pendingApproval: true },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        name: true,
        handle: true,
        email: true,
        createdAt: true,
      },
    }),
    db.user.findMany({
      where: {
        organizationId: actor.org,
        active: false,
        pendingApproval: false,
        passwordHash: "",
        email: { contains: "@imported." },
      },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        _count: { select: { experiments: true } },
      },
    }),
  ]);
  const legacyOptions = placeholders.map((p) => ({
    id: p.id,
    name: p.name,
    experiments: p._count.experiments,
  }));
  return {
    approvals: pendingUsers.map((u) => ({
      id: u.id,
      name: u.name,
      handle: u.handle,
      email: u.email,
      createdAt: u.createdAt.toISOString().slice(0, 16).replace("T", " "),
      suggestedLegacyId:
        placeholders.find((p) => nameKey(p.name) === nameKey(u.name))?.id ??
        null,
    })),
    legacyOptions,
  };
}

/**
 * Approve a registration, with the admin's corrections applied. When a legacy
 * placeholder is selected, the approval CLAIMS it — the newcomer's credentials
 * move into the placeholder row (so its userNumber and every imported
 * experiment become theirs untouched) and the empty pending row is deleted.
 * A pending user has never signed in, so that row owns nothing.
 */
export async function approveRegistration(
  actor: Actor,
  raw: unknown,
): Promise<void> {
  assertAdmin(actor);
  const { userId, name, handle, email, legacyUserId } =
    registrationApprovalSchema.parse(raw);
  await db.$transaction(async (tx) => {
    const pending = await tx.user.findFirst({
      where: { id: userId, organizationId: actor.org, pendingApproval: true },
      select: { id: true, email: true, passwordHash: true, language: true },
    });
    if (!pending) throw new Error("No such pending registration.");

    if (legacyUserId) {
      const legacy = await tx.user.findFirst({
        where: {
          id: legacyUserId,
          organizationId: actor.org,
          active: false,
          pendingApproval: false,
          passwordHash: "",
          email: { contains: "@imported." },
        },
        select: { id: true, name: true },
      });
      if (!legacy) throw new Error("That legacy dataset is not claimable.");
      // Delete first so the email can move without a unique-index collision.
      await tx.user.delete({ where: { id: pending.id } });
      if (email !== pending.email) {
        const taken = await tx.user.findUnique({
          where: { email },
          select: { id: true },
        });
        if (taken) throw new Error("exists");
      }
      await tx.user.update({
        where: { id: legacy.id },
        data: {
          email,
          name,
          handle,
          passwordHash: pending.passwordHash,
          language: pending.language,
          active: true,
        },
      });
      await recordUserAudit(tx, {
        actor,
        action: "user.registration.approved",
        entityType: "User",
        entityId: legacy.id,
        changes: {
          name,
          email,
          claimedLegacyUser: legacy.id,
          legacyName: legacy.name,
          replacedPendingUser: pending.id,
        },
      });
      return;
    }

    if (email !== pending.email) {
      const taken = await tx.user.findUnique({
        where: { email },
        select: { id: true },
      });
      if (taken) throw new Error("exists");
    }
    await tx.user.update({
      where: { id: pending.id },
      data: { name, handle, email, active: true, pendingApproval: false },
    });
    await recordUserAudit(tx, {
      actor,
      action: "user.registration.approved",
      entityType: "User",
      entityId: pending.id,
      changes: { name, email },
    });
  });
}

/** Reject (delete) a pending registration — the person can register again. */
export async function rejectRegistration(
  actor: Actor,
  userId: string,
): Promise<void> {
  assertAdmin(actor);
  const id = entityIdSchema.parse(userId);
  await db.$transaction(async (tx) => {
    const pending = await tx.user.findFirst({
      where: { id, organizationId: actor.org, pendingApproval: true },
      select: { id: true, email: true },
    });
    if (!pending) throw new Error("No such pending registration.");
    await tx.user.delete({ where: { id: pending.id } });
    await recordUserAudit(tx, {
      actor,
      action: "user.registration.rejected",
      entityType: "User",
      entityId: pending.id,
      changes: { email: pending.email },
    });
  });
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

/**
 * Admin normalizes a teammate's name and sign-in email — the lab is unifying
 * everyone onto English names and the szpheno.com domain. The email is the
 * login identifier, so uniqueness is checked; sessions and NFC badges keep
 * working because both key on the user id.
 */
export async function updateUserIdentity(
  actor: Actor,
  userId: string,
  raw: unknown,
) {
  assertAdmin(actor);
  const id = entityIdSchema.parse(userId);
  const { name, email } = userIdentitySchema.parse(raw);
  await db.$transaction(async (tx) => {
    const current = await tx.user.findFirst({
      where: { id, organizationId: actor.org },
      select: { name: true, email: true },
    });
    if (!current) throw new Error("User not found.");
    if (email !== current.email) {
      const taken = await tx.user.findUnique({
        where: { email },
        select: { id: true },
      });
      if (taken) throw new Error("exists");
    }
    await tx.user.update({ where: { id }, data: { name, email } });
    await recordUserAudit(tx, {
      actor,
      action: "user.identity.update",
      entityType: "User",
      entityId: id,
      changes: {
        name,
        email,
        previousName: current.name,
        previousEmail: current.email,
      },
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
