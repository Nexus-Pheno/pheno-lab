import bcrypt from "bcryptjs";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/infrastructure/db/client";
import type { Actor } from "@/modules/authorization/actor";
import {
  requestPasswordReset,
  verifyPasswordReset,
} from "@/modules/accounts/password-reset-service";
import { adminResetPassword } from "@/modules/accounts/registration-service";

afterAll(async () => {
  await db.$disconnect();
});

async function removeOrganization(organizationId: string): Promise<void> {
  await db.auditEvent.deleteMany({ where: { organizationId } });
  await db.otpCode.deleteMany({ where: { organizationId } });
  await db.user.deleteMany({ where: { organizationId } });
  await db.organization.delete({ where: { id: organizationId } });
}

async function fixture(prefix: string) {
  const suffix = crypto.randomUUID();
  const organization = await db.organization.create({
    data: { name: `${prefix} Org`, slug: `${prefix}-${suffix}` },
  });
  const email = `${prefix}-${suffix}@example.test`;
  const user = await db.user.create({
    data: {
      organizationId: organization.id,
      email,
      name: `${prefix} User`,
      passwordHash: await bcrypt.hash("original-pass", 10),
      role: "TECHNICIAN",
    },
  });
  const admin: Actor = {
    uid: (
      await db.user.create({
        data: {
          organizationId: organization.id,
          email: `${prefix}-admin-${suffix}@example.test`,
          name: `${prefix} Admin`,
          passwordHash: "test-only",
          role: "ADMIN",
        },
      })
    ).id,
    org: organization.id,
    role: "ADMIN",
  };
  return { organization, user, email, admin };
}

describe("password reset against PostgreSQL", () => {
  it("issues a code, sets the new password once, and audits both steps", async () => {
    const f = await fixture("reset-happy");
    try {
      const requested = await requestPasswordReset(f.email);
      expect(requested.ok).toBe(true);

      const otp = await db.otpCode.findFirstOrThrow({
        where: { email: f.email, purpose: "reset", usedAt: null },
      });
      const verified = await verifyPasswordReset({
        email: f.email,
        code: otp.code,
        password: "brand-new-pass",
      });
      expect(verified.ok).toBe(true);

      const after = await db.user.findUniqueOrThrow({
        where: { id: f.user.id },
        select: { passwordHash: true },
      });
      expect(await bcrypt.compare("brand-new-pass", after.passwordHash)).toBe(
        true,
      );
      const used = await db.otpCode.findUniqueOrThrow({
        where: { id: otp.id },
      });
      expect(used.usedAt).not.toBeNull();

      // A consumed code cannot be replayed.
      const replay = await verifyPasswordReset({
        email: f.email,
        code: otp.code,
        password: "yet-another-pass",
      });
      expect(replay.ok).toBe(false);

      for (const action of [
        "user.password.reset_requested",
        "user.password.reset",
      ]) {
        expect(
          await db.auditEvent.count({
            where: {
              organizationId: f.organization.id,
              entityId: f.user.id,
              action,
              actorType: "SYSTEM",
            },
          }),
        ).toBe(1);
      }
    } finally {
      await removeOrganization(f.organization.id);
    }
  });

  it("answers identically for unknown emails and creates nothing", async () => {
    const f = await fixture("reset-enum");
    try {
      const ghost = `ghost-${crypto.randomUUID()}@example.test`;
      const res = await requestPasswordReset(ghost);
      expect(res.ok).toBe(true);
      expect(await db.otpCode.count({ where: { email: ghost } })).toBe(0);
    } finally {
      await removeOrganization(f.organization.id);
    }
  });

  it("burns the code after five wrong guesses", async () => {
    const f = await fixture("reset-brute");
    try {
      await requestPasswordReset(f.email);
      const otp = await db.otpCode.findFirstOrThrow({
        where: { email: f.email, purpose: "reset" },
      });
      const wrong = otp.code === "111111" ? "222222" : "111111";
      for (let i = 0; i < 5; i++) {
        const res = await verifyPasswordReset({
          email: f.email,
          code: wrong,
          password: "attacker-pass1",
        });
        expect(res.ok).toBe(false);
      }
      // Even the RIGHT code is dead now.
      const res = await verifyPasswordReset({
        email: f.email,
        code: otp.code,
        password: "attacker-pass1",
      });
      expect(res.ok).toBe(false);
      const after = await db.user.findUniqueOrThrow({
        where: { id: f.user.id },
        select: { passwordHash: true },
      });
      expect(await bcrypt.compare("original-pass", after.passwordHash)).toBe(
        true,
      );
    } finally {
      await removeOrganization(f.organization.id);
    }
  });

  it("lets admins set a password directly, and only admins", async () => {
    const f = await fixture("reset-admin");
    try {
      await adminResetPassword(f.admin, f.user.id, "admin-chosen-pass");
      const after = await db.user.findUniqueOrThrow({
        where: { id: f.user.id },
        select: { passwordHash: true },
      });
      expect(
        await bcrypt.compare("admin-chosen-pass", after.passwordHash),
      ).toBe(true);
      expect(
        await db.auditEvent.count({
          where: {
            organizationId: f.organization.id,
            entityId: f.user.id,
            action: "user.password.reset.admin",
            actorUserId: f.admin.uid,
          },
        }),
      ).toBe(1);

      const technician: Actor = {
        uid: f.user.id,
        org: f.organization.id,
        role: "TECHNICIAN",
      };
      await expect(
        adminResetPassword(technician, f.admin.uid, "sneaky-pass1"),
      ).rejects.toThrow();
    } finally {
      await removeOrganization(f.organization.id);
    }
  });
});
