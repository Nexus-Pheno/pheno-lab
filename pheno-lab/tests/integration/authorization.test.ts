import type { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/infrastructure/db/client";
import {
  experimentVisibilityScope,
  measurementVisibilityScope,
} from "@/modules/authorization/scope";
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

describe("instrument measurement visibility against PostgreSQL", () => {
  it("routes each scan to the sample's experiment, its owner, or the manager queue", async () => {
    await withRollback(async (transaction) => {
      const suffix = crypto.randomUUID();
      const org = await transaction.organization.create({
        data: { name: "Scope Org", slug: `scope-${suffix}`, orgNumber: 301 },
      });
      const person = (name: string, role: "ADMIN" | "MANAGER" | "TECHNICIAN") =>
        transaction.user.create({
          data: {
            organizationId: org.id,
            email: `${name}-${suffix}@example.test`,
            name,
            passwordHash: "test-only",
            role,
          },
        });
      const [admin, manager, otherManager, tech, otherTech] = await Promise.all(
        [
          person("Admin", "ADMIN"),
          person("Manager", "MANAGER"),
          person("OtherManager", "MANAGER"),
          person("Tech", "TECHNICIAN"),
          person("OtherTech", "TECHNICIAN"),
        ],
      );

      // One experiment, owned by `manager`, with `tech` as its only member.
      const experiment = await transaction.experiment.create({
        data: {
          organizationId: org.id,
          code: `SCOPE-${suffix.slice(0, 8)}`,
          title: "Scoped batch",
          createdById: manager.id,
          samples: { create: [{ code: "S1" }] },
          members: { create: [{ userId: tech.id }] },
        },
        include: { samples: true },
      });
      const instrument = await transaction.instrument.create({
        data: {
          organizationId: org.id,
          name: `rig-${suffix}`,
          kind: "GIANTFORCE_IV",
          apiKeyHash: `hash-${suffix}`,
        },
      });
      const upload = await transaction.instrumentUpload.create({
        data: {
          instrumentId: instrument.id,
          fileName: "f.csv",
          storedPath: `k-${suffix}`,
          sha256: `sha-${suffix}`,
          size: 1,
          status: "PARSED",
        },
      });
      const scan = (
        label: string,
        extra: Prisma.JvMeasurementUncheckedCreateInput extends never
          ? never
          : Record<string, unknown>,
      ) =>
        transaction.jvMeasurement.create({
          data: {
            organizationId: org.id,
            instrumentId: instrument.id,
            uploadId: upload.id,
            serial: label,
            serialKey: label,
            scanKey: `${label}-${suffix}`,
            metrics: {},
            curve: [],
            status: "UNMATCHED",
            ...extra,
          },
        });

      const attached = await scan("attached", {
        status: "MATCHED",
        experimentId: experiment.id,
        sampleId: experiment.samples[0].id,
      });
      const ownedByTech = await scan("owned", { assignedToId: tech.id });
      const orphan = await scan("orphan", {});

      const visibleTo = async (actor: {
        uid: string;
        role: "ADMIN" | "MANAGER" | "TECHNICIAN";
      }) => {
        const rows = await transaction.jvMeasurement.findMany({
          where: measurementVisibilityScope({ ...actor, org: org.id }),
          select: { id: true },
        });
        return new Set(rows.map((r) => r.id));
      };

      // Admin: everything.
      const forAdmin = await visibleTo({ uid: admin.id, role: "ADMIN" });
      expect(forAdmin).toEqual(
        new Set([attached.id, ownedByTech.id, orphan.id]),
      );

      // The experiment's manager: their batch plus the unowned queue. NOT the
      // scan already handed to the technician.
      const forManager = await visibleTo({ uid: manager.id, role: "MANAGER" });
      expect(forManager.has(attached.id)).toBe(true);
      expect(forManager.has(orphan.id)).toBe(true);
      expect(forManager.has(ownedByTech.id)).toBe(false);

      // A manager who is not on the experiment must not read its results —
      // this is the leak that existed when the page filtered on org alone.
      const forOtherManager = await visibleTo({
        uid: otherManager.id,
        role: "MANAGER",
      });
      expect(forOtherManager.has(attached.id)).toBe(false);
      expect(forOtherManager.has(orphan.id)).toBe(true);

      // The member technician: their experiment and their own handed-over scan,
      // but never the shared orphan queue.
      const forTech = await visibleTo({ uid: tech.id, role: "TECHNICIAN" });
      expect(forTech).toEqual(new Set([attached.id, ownedByTech.id]));

      // An unrelated technician sees nothing at all.
      const forOtherTech = await visibleTo({
        uid: otherTech.id,
        role: "TECHNICIAN",
      });
      expect(forOtherTech.size).toBe(0);
    });
  });
});
