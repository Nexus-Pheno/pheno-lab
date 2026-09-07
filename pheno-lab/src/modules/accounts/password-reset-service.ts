import "server-only";

import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { db } from "@/infrastructure/db/client";
import {
  isMailConfigured,
  resetEmail,
  sendMail,
} from "@/infrastructure/mail/mailer";
import { log } from "@/infrastructure/logging/logger";
import { recordSystemAudit } from "@/modules/audit/writer";
import { emailSchema, passwordResetSchema } from "./schema";

// Self-service password reset, built on the same OtpCode machinery as
// registration but hardened for its different threat model: the request
// endpoint must not reveal whether an account exists, and the code must not
// be brute-forceable (5 wrong guesses burn it; registration codes create an
// account the attacker then owns anyway, reset codes take over someone
// else's).

const CODE_TTL_MS = 15 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;

/**
 * Issue a reset code. The response depends only on whether SMTP is
 * configured — never on whether the account exists — so this endpoint cannot
 * be used to enumerate emails. Codes are only actually created for active,
 * approved accounts; the admin's Users page is the no-SMTP fallback channel.
 */
export async function requestPasswordReset(
  emailRaw: string,
): Promise<{ ok: true; emailed: boolean }> {
  const emailed = isMailConfigured();
  const parsedEmail = emailSchema.safeParse(emailRaw);
  if (!parsedEmail.success) return { ok: true, emailed };
  const email = parsedEmail.data;

  const user = await db.user.findFirst({
    where: {
      email,
      active: true,
      pendingApproval: false,
      organization: { status: "ACTIVE" },
    },
    select: { id: true, organizationId: true },
  });
  if (!user) return { ok: true, emailed };

  const code = crypto.randomInt(100000, 999999).toString();
  const issued = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`reset:${email}`}, 0))`;
    // A fresh unused code within the cooldown window is left alone — this
    // caps email volume and stops a stranger from invalidating the code the
    // real owner is about to type.
    const recent = await tx.otpCode.findFirst({
      where: {
        email,
        purpose: "reset",
        usedAt: null,
        expiresAt: { gt: new Date() },
        createdAt: { gt: new Date(Date.now() - RESEND_COOLDOWN_MS) },
      },
      select: { id: true },
    });
    if (recent) return false;
    await tx.otpCode.deleteMany({
      where: { email, purpose: "reset", usedAt: null },
    });
    await tx.otpCode.create({
      data: {
        organizationId: user.organizationId,
        email,
        code,
        purpose: "reset",
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
      },
    });
    await recordSystemAudit(tx, {
      organizationId: user.organizationId,
      action: "user.password.reset_requested",
      entityType: "User",
      entityId: user.id,
    });
    return true;
  });

  if (issued && emailed) {
    try {
      const m = resetEmail(code);
      await sendMail(email, m.subject, m.text, m.html);
    } catch (error) {
      log.error("reset.smtp_failed", {
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
  return { ok: true, emailed };
}

/**
 * Verify a reset code and set the new password. Wrong guesses are counted
 * inside the same advisory-locked transaction that would consume the code,
 * so parallel guessing cannot bypass the attempt cap.
 */
export async function verifyPasswordReset(raw: {
  email: string;
  code: string;
  password: string;
}): Promise<{ ok: boolean; error?: string }> {
  const parsed = passwordResetSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "bad-code" };
  const { email, code, password } = parsed.data;
  const passwordHash = await bcrypt.hash(password, 10);

  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`reset:${email}`}, 0))`;
    const otp = await tx.otpCode.findFirst({
      where: {
        email,
        purpose: "reset",
        usedAt: null,
        expiresAt: { gt: new Date() },
        attempts: { lt: MAX_ATTEMPTS },
      },
    });
    if (!otp) return { ok: false, error: "bad-code" };
    if (otp.code !== code) {
      await tx.otpCode.update({
        where: { id: otp.id },
        data: { attempts: { increment: 1 } },
      });
      return { ok: false, error: "bad-code" };
    }
    const user = await tx.user.findFirst({
      where: {
        email,
        active: true,
        pendingApproval: false,
        organizationId: otp.organizationId,
      },
      select: { id: true },
    });
    if (!user) return { ok: false, error: "bad-code" };
    await tx.otpCode.update({
      where: { id: otp.id },
      data: { usedAt: new Date() },
    });
    await tx.user.update({
      where: { id: user.id },
      data: { passwordHash },
    });
    await recordSystemAudit(tx, {
      organizationId: otp.organizationId,
      action: "user.password.reset",
      entityType: "User",
      entityId: user.id,
    });
    return { ok: true };
  });
}
