"use server";

import crypto from "crypto";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { isMailConfigured, sendMail, otpEmail } from "@/lib/mail";

// Registration is OTP-based and restricted to an organization's email
// domains. Codes are emailed via SMTP when configured; the admin's Users
// page always shows pending codes as a fallback channel.

const CODE_TTL_MS = 15 * 60 * 1000;

function orgForEmail(email: string) {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return null;
  return db.organization.findFirst({ where: { emailDomains: { has: domain }, status: "ACTIVE" } });
}

export async function requestRegistration(
  emailRaw: string
): Promise<{ ok: boolean; error?: string; emailed?: boolean }> {
  const email = emailRaw.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: "bad-domain" };

  const existing = await db.user.findUnique({ where: { email } });
  if (existing) return { ok: false, error: "exists" };

  const org = await orgForEmail(email);
  if (!org) return { ok: false, error: "bad-domain" };

  // Invalidate previous codes for this email, then issue a fresh one.
  await db.otpCode.deleteMany({ where: { email, usedAt: null } });
  const code = crypto.randomInt(100000, 999999).toString();
  await db.otpCode.create({
    data: {
      organizationId: org.id,
      email,
      code,
      purpose: "register",
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    },
  });
  // Primary delivery: email via SMTP. Fallback (SMTP unset or send failed):
  // server log + the admin's Users page, which always lists pending codes.
  console.log(`[pheno-lab] Registration passcode for ${email}: ${code} (valid 15 min)`);
  if (isMailConfigured()) {
    try {
      const m = otpEmail(code);
      await sendMail(email, m.subject, m.text, m.html);
      return { ok: true, emailed: true };
    } catch (err) {
      console.error(`[pheno-lab] SMTP send failed for ${email}:`, err);
    }
  }
  return { ok: true, emailed: false };
}

export async function verifyRegistration(data: {
  email: string;
  code: string;
  name: string;
  password: string;
}): Promise<{ ok: boolean; error?: string }> {
  const email = data.email.trim().toLowerCase();
  const otp = await db.otpCode.findFirst({
    where: { email, code: data.code.trim(), purpose: "register", usedAt: null, expiresAt: { gt: new Date() } },
  });
  if (!otp) return { ok: false, error: "bad-code" };
  if (data.password.length < 8) return { ok: false, error: "bad-code" };
  if (await db.user.findUnique({ where: { email } })) return { ok: false, error: "exists" };

  const passwordHash = await bcrypt.hash(data.password, 10);
  await db.$transaction(async (tx) => {
    await tx.otpCode.update({ where: { id: otp.id }, data: { usedAt: new Date() } });
    // Each user gets the next sequential number in their organization —
    // it becomes part of every experiment code they create.
    const max = await tx.user.aggregate({
      where: { organizationId: otp.organizationId },
      _max: { userNumber: true },
    });
    const isFirstUser = max._max.userNumber === null;
    await tx.user.create({
      data: {
        organizationId: otp.organizationId,
        email,
        name: data.name.trim() || email.split("@")[0],
        passwordHash,
        userNumber: (max._max.userNumber ?? 0) + 1,
        // First member of an organization becomes its designated admin;
        // everyone after starts as technician and is promoted by the admin.
        role: isFirstUser ? "ADMIN" : "TECHNICIAN",
      },
    });
  });
  return { ok: true };
}

// ---- Admin: user management ----

/** Admin creates an account directly (email + password), skipping OTP —
 * for colleagues who can't receive the passcode email yet. */
export async function createUserAccount(data: {
  name: string;
  email: string;
  password: string;
  role: "ADMIN" | "MANAGER" | "TECHNICIAN";
}): Promise<{ ok: boolean; error?: string }> {
  const session = await requireAdmin();
  const email = data.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: "bad-input" };
  if (data.password.length < 8) return { ok: false, error: "bad-input" };
  if (await db.user.findUnique({ where: { email } })) return { ok: false, error: "exists" };

  const passwordHash = await bcrypt.hash(data.password, 10);
  await db.$transaction(async (tx) => {
    const max = await tx.user.aggregate({
      where: { organizationId: session.org },
      _max: { userNumber: true },
    });
    await tx.user.create({
      data: {
        organizationId: session.org,
        email,
        name: data.name.trim() || email.split("@")[0],
        passwordHash,
        userNumber: (max._max.userNumber ?? 0) + 1,
        role: data.role,
      },
    });
  });
  return { ok: true };
}

export async function setUserRole(userId: string, role: "ADMIN" | "MANAGER" | "TECHNICIAN") {
  const session = await requireAdmin();
  if (userId === session.uid) throw new Error("You cannot change your own role.");
  await db.user.updateMany({ where: { id: userId, organizationId: session.org }, data: { role } });
}

export async function setUserActive(userId: string, active: boolean) {
  const session = await requireAdmin();
  if (userId === session.uid) throw new Error("You cannot deactivate yourself.");
  await db.user.updateMany({ where: { id: userId, organizationId: session.org }, data: { active } });
}

export async function setEmailDomains(domainsCsv: string) {
  const session = await requireAdmin();
  // Split on ASCII and CJK separators alike (，、；;) — a full-width comma
  // once glued two domains into one unmatched entry.
  const domains = [...new Set(
    domainsCsv
      .split(/[,，、;；\s]+/)
      .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
      .filter(Boolean)
  )];
  await db.organization.update({ where: { id: session.org }, data: { emailDomains: domains } });
}
