import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/infrastructure/db/client";
import type { Actor, ActorRole } from "@/modules/authorization/actor";
import { setUserStewardship } from "@/modules/library/service";
import { getOrganizationManagementData } from "@/modules/organizations/query";
import {
  approveRegistration,
  createUserAccount,
  listRegistrationApprovals,
  rejectRegistration,
  setUserRole,
  adminResetPassword,
} from "@/modules/accounts/registration-service";

afterAll(() => db.$disconnect());

async function fixture() {
  const suffix = crypto.randomUUID();
  const org = await db.organization.create({
    data: { name: "Membership test", slug: `members-${suffix}` },
  });
  const person = async (label: string, role: ActorRole, extra = {}) => {
    const row = await db.user.create({
      data: {
        organizationId: org.id,
        name: label,
        email: `${label}-${suffix}@example.test`,
        passwordHash: "test-only",
        role,
        ...extra,
      },
    });
    return { row, actor: { uid: row.id, org: org.id, role } satisfies Actor };
  };
  const admin = await person("admin", "ADMIN");
  const delegate = await person("delegate", "MANAGER");
  const pending = await person("newcomer", "TECHNICIAN", {
    active: false,
    pendingApproval: true,
  });
  return { org, suffix, person, admin, delegate, pending };
}

async function cleanup(org: string) {
  await db.auditEvent.deleteMany({ where: { organizationId: org } });
  await db.otpCode.deleteMany({ where: { organizationId: org } });
  await db.user.deleteMany({ where: { organizationId: org } });
  await db.organization.delete({ where: { id: org } });
}

const approval = (
  row: { id: string; email: string; name: string },
  extra = {},
) => ({
  userId: row.id,
  name: row.name,
  email: row.email,
  ...extra,
});

describe("delegated membership against PostgreSQL", () => {
  it("requires a grant, approves and creates technicians with audits, then immediately honors revocation", async () => {
    const f = await fixture();
    try {
      await expect(
        listRegistrationApprovals(f.delegate.actor),
      ).rejects.toThrow();
      await expect(
        approveRegistration(f.delegate.actor, approval(f.pending.row)),
      ).rejects.toThrow();
      const input = {
        name: "invited",
        email: `invited-${f.suffix}@example.test`,
        password: "test-password-only",
        role: "TECHNICIAN" as const,
      };
      await expect(
        createUserAccount(input, f.delegate.actor),
      ).rejects.toThrow();
      await setUserStewardship(
        f.admin.actor,
        f.delegate.row.id,
        "memberAdmin",
        true,
      );
      expect(
        (await listRegistrationApprovals(f.delegate.actor)).approvals.map(
          (a) => a.id,
        ),
      ).toEqual([f.pending.row.id]);
      await approveRegistration(f.delegate.actor, approval(f.pending.row));
      expect(await createUserAccount(input, f.delegate.actor)).toEqual({
        ok: true,
      });
      const approved = await db.user.findUniqueOrThrow({
        where: { id: f.pending.row.id },
      });
      expect(approved).toMatchObject({
        active: true,
        pendingApproval: false,
        role: "TECHNICIAN",
      });
      expect(
        await db.auditEvent.count({
          where: {
            actorUserId: f.delegate.row.id,
            action: { in: ["user.registration.approved", "user.create"] },
          },
        }),
      ).toBe(2);
      await setUserStewardship(
        f.admin.actor,
        f.delegate.row.id,
        "memberAdmin",
        false,
      );
      await expect(
        listRegistrationApprovals(f.delegate.actor),
      ).rejects.toThrow();
      await expect(
        createUserAccount(
          { ...input, email: `revoked-${f.suffix}@example.test` },
          f.delegate.actor,
        ),
      ).rejects.toThrow();
    } finally {
      await cleanup(f.org.id);
    }
  });

  it("does not disclose OTPs or research claims and cannot elevate, reset, reject or grant permissions", async () => {
    const f = await fixture();
    try {
      await setUserStewardship(
        f.admin.actor,
        f.delegate.row.id,
        "memberAdmin",
        true,
      );
      const legacy = await f.person("legacy", "TECHNICIAN", {
        active: false,
        passwordHash: "",
        email: `legacy@imported.${f.suffix}`,
      });
      await db.otpCode.create({
        data: {
          organizationId: f.org.id,
          email: f.admin.row.email,
          code: "123456",
          purpose: "reset",
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      expect(
        await getOrganizationManagementData(f.delegate.actor),
      ).toMatchObject({ users: [], pending: [] });
      expect(
        (await listRegistrationApprovals(f.delegate.actor)).legacyOptions,
      ).toEqual([]);
      await expect(
        approveRegistration(
          f.delegate.actor,
          approval(f.pending.row, { legacyUserId: legacy.row.id }),
        ),
      ).rejects.toThrow();
      for (const role of ["ADMIN", "MANAGER"] as const) {
        await expect(
          createUserAccount(
            {
              name: "staff",
              email: `staff-${role}-${f.suffix}@example.test`,
              password: "test-password-only",
              role,
            },
            f.delegate.actor,
          ),
        ).rejects.toThrow();
      }
      await expect(
        setUserRole(f.delegate.actor, f.pending.row.id, "ADMIN"),
      ).rejects.toThrow();
      await expect(
        adminResetPassword(
          f.delegate.actor,
          f.admin.row.id,
          "replacement-test-password",
        ),
      ).rejects.toThrow();
      await expect(
        rejectRegistration(f.delegate.actor, f.pending.row.id),
      ).rejects.toThrow();
      await expect(
        setUserStewardship(
          f.delegate.actor,
          f.pending.row.id,
          "memberAdmin",
          true,
        ),
      ).rejects.toThrow();
      expect(
        await createUserAccount(
          {
            name: "legacy",
            email: `fresh-${f.suffix}@example.test`,
            password: "test-password-only",
            role: "TECHNICIAN",
          },
          f.delegate.actor,
        ),
      ).toEqual({ ok: true });
      expect(
        await db.user.findUniqueOrThrow({ where: { id: legacy.row.id } }),
      ).toMatchObject({ active: false, passwordHash: "" });
      expect(
        await db.user.findUniqueOrThrow({ where: { id: f.pending.row.id } }),
      ).toMatchObject({ active: false, pendingApproval: true });
      expect(
        await db.auditEvent.count({
          where: { actorUserId: f.delegate.row.id },
        }),
      ).toBe(1);
    } finally {
      await cleanup(f.org.id);
    }
  });

  it("isolates organizations and rejects an actor claiming a different organization", async () => {
    const home = await fixture();
    const foreign = await fixture();
    try {
      await setUserStewardship(
        home.admin.actor,
        home.delegate.row.id,
        "memberAdmin",
        true,
      );
      await expect(
        approveRegistration(home.delegate.actor, approval(foreign.pending.row)),
      ).rejects.toThrow();
      await expect(
        setUserStewardship(
          home.admin.actor,
          foreign.delegate.row.id,
          "memberAdmin",
          true,
        ),
      ).rejects.toThrow();
      await expect(
        listRegistrationApprovals({
          ...home.delegate.actor,
          org: foreign.org.id,
        }),
      ).rejects.toThrow();
      expect(
        (await listRegistrationApprovals(home.delegate.actor)).approvals.map(
          (a) => a.id,
        ),
      ).toEqual([home.pending.row.id]);
      expect(
        await db.auditEvent.count({
          where: { organizationId: foreign.org.id },
        }),
      ).toBe(0);
    } finally {
      await cleanup(home.org.id);
      await cleanup(foreign.org.id);
    }
  });

  it("refuses inactive delegates and non-technician pending accounts", async () => {
    const f = await fixture();
    try {
      await setUserStewardship(
        f.admin.actor,
        f.delegate.row.id,
        "memberAdmin",
        true,
      );
      await db.user.update({
        where: { id: f.pending.row.id },
        data: { role: "ADMIN" },
      });
      await expect(
        approveRegistration(f.delegate.actor, approval(f.pending.row)),
      ).rejects.toThrow();
      await db.user.update({
        where: { id: f.delegate.row.id },
        data: { active: false },
      });
      await expect(
        listRegistrationApprovals(f.delegate.actor),
      ).rejects.toThrow();
      expect(
        await db.auditEvent.count({
          where: { actorUserId: f.delegate.row.id },
        }),
      ).toBe(0);
    } finally {
      await cleanup(f.org.id);
    }
  });

  it("rolls back failed approvals and preserves full admin enrollment", async () => {
    const f = await fixture();
    try {
      await setUserStewardship(
        f.admin.actor,
        f.delegate.row.id,
        "memberAdmin",
        true,
      );
      await expect(
        approveRegistration(
          f.delegate.actor,
          approval(f.pending.row, { email: f.admin.row.email }),
        ),
      ).rejects.toThrow("exists");
      expect(
        await db.user.findUniqueOrThrow({ where: { id: f.pending.row.id } }),
      ).toMatchObject({ active: false, pendingApproval: true });
      expect(
        await db.auditEvent.count({
          where: { actorUserId: f.delegate.row.id },
        }),
      ).toBe(0);
      const legacy = await f.person("legacy", "TECHNICIAN", {
        active: false,
        passwordHash: "",
        email: `legacy@imported.${f.suffix}`,
      });
      await approveRegistration(
        f.admin.actor,
        approval(f.pending.row, { legacyUserId: legacy.row.id }),
      );
      expect(
        await db.user.findUnique({ where: { id: f.pending.row.id } }),
      ).toBeNull();
      expect(
        await db.user.findUniqueOrThrow({ where: { id: legacy.row.id } }),
      ).toMatchObject({ active: true, email: f.pending.row.email });
      expect(
        await createUserAccount(
          {
            name: "staff",
            email: `admin-created-${f.suffix}@example.test`,
            password: "test-password-only",
            role: "MANAGER",
          },
          f.admin.actor,
        ),
      ).toEqual({ ok: true });
      expect(
        (await getOrganizationManagementData(f.admin.actor)).users.length,
      ).toBeGreaterThan(0);
    } finally {
      await cleanup(f.org.id);
    }
  });
});
