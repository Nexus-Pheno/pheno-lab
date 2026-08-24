import type { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/infrastructure/db/client";
import { experimentVisibilityScope } from "@/modules/authorization/scope";
import { recordUserAudit } from "@/modules/audit/writer";

const rollback = new Error("ROLLBACK_TEST_TRANSACTION");

async function withRollback(
  test: (transaction: Prisma.TransactionClient) => Promise<void>,
): Promise<void> {
  try {
    await db.$transaction(async (transaction) => {
      await test(transaction);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

afterAll(async () => {
  await db.$disconnect();
});

describe("organization isolation against PostgreSQL", () => {
  it("never returns another organization's experiments", async () => {
    await withRollback(async (transaction) => {
      const suffix = crypto.randomUUID();
      const [orgA, orgB] = await Promise.all([
        transaction.organization.create({
          data: { name: "Org A", slug: `org-a-${suffix}`, orgNumber: 101 },
        }),
        transaction.organization.create({
          data: { name: "Org B", slug: `org-b-${suffix}`, orgNumber: 102 },
        }),
      ]);
      const [managerA, technicianA, adminB] = await Promise.all([
        transaction.user.create({
          data: {
            organizationId: orgA.id,
            email: `manager-a-${suffix}@example.test`,
            name: "Manager A",
            passwordHash: "test-only",
            role: "MANAGER",
          },
        }),
        transaction.user.create({
          data: {
            organizationId: orgA.id,
            email: `technician-a-${suffix}@example.test`,
            name: "Technician A",
            passwordHash: "test-only",
            role: "TECHNICIAN",
          },
        }),
        transaction.user.create({
          data: {
            organizationId: orgB.id,
            email: `admin-b-${suffix}@example.test`,
            name: "Admin B",
            passwordHash: "test-only",
            role: "ADMIN",
          },
        }),
      ]);
      const [experimentA, experimentB] = await Promise.all([
        transaction.experiment.create({
          data: {
            organizationId: orgA.id,
            code: `A-${suffix}`,
            title: "Visible in Org A",
            createdById: managerA.id,
            members: { create: { userId: technicianA.id } },
          },
        }),
        transaction.experiment.create({
          data: {
            organizationId: orgB.id,
            code: `B-${suffix}`,
            title: "Private to Org B",
            createdById: adminB.id,
          },
        }),
      ]);

      const managerRows = await transaction.experiment.findMany({
        where: experimentVisibilityScope({
          uid: managerA.id,
          org: orgA.id,
          role: "MANAGER",
        }),
        select: { id: true },
      });
      expect(managerRows.map((row) => row.id)).toEqual([experimentA.id]);

      const technicianRows = await transaction.experiment.findMany({
        where: experimentVisibilityScope({
          uid: technicianA.id,
          org: orgA.id,
          role: "TECHNICIAN",
        }),
        select: { id: true },
      });
      expect(technicianRows.map((row) => row.id)).toEqual([experimentA.id]);
      expect(technicianRows.some((row) => row.id === experimentB.id)).toBe(
        false,
      );
    });
  });

  it("rolls business data and its audit event back together", async () => {
    const entityId = `rollback-${crypto.randomUUID()}`;
    await withRollback(async (transaction) => {
      const suffix = crypto.randomUUID();
      const org = await transaction.organization.create({
        data: { name: "Audit Org", slug: `audit-org-${suffix}` },
      });
      const user = await transaction.user.create({
        data: {
          organizationId: org.id,
          email: `audit-user-${suffix}@example.test`,
          name: "Audit User",
          passwordHash: "test-only",
          role: "ADMIN",
        },
      });
      await transaction.experiment.create({
        data: {
          id: entityId,
          organizationId: org.id,
          code: `AUDIT-${suffix}`,
          title: "Audit transaction",
          createdById: user.id,
        },
      });
      await recordUserAudit(transaction, {
        actor: { uid: user.id, org: org.id, role: "ADMIN" },
        action: "experiment.create",
        entityType: "Experiment",
        entityId,
      });
      expect(await transaction.auditEvent.count({ where: { entityId } })).toBe(
        1,
      );
    });

    expect(await db.auditEvent.count({ where: { entityId } })).toBe(0);
    expect(await db.experiment.count({ where: { id: entityId } })).toBe(0);
  });
});
