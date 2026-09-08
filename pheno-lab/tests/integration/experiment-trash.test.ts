import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/infrastructure/db/client";
import type { Actor, ActorRole } from "@/modules/authorization/actor";
import {
  deleteExperiment,
  duplicateExperiment,
  updateExperimentMeta,
} from "@/modules/experiments/service";
import {
  getExperimentDesignerData,
  listDashboardExperiments,
} from "@/modules/experiments/query";
import {
  listTrash,
  purgeExperiment,
  restoreExperiment,
} from "@/modules/experiments/trash-service";
import { matchSerial } from "@/modules/instruments/matching-service";

afterAll(async () => {
  await db.$disconnect();
});

async function removeOrganization(organizationId: string): Promise<void> {
  await db.auditEvent.deleteMany({ where: { organizationId } });
  await db.experiment.deleteMany({ where: { organizationId } });
  await db.user.deleteMany({ where: { organizationId } });
  await db.organization.delete({ where: { id: organizationId } });
}

async function fixture() {
  const suffix = crypto.randomUUID();
  const organization = await db.organization.create({
    data: { name: "Trash Org", slug: `trash-${suffix}` },
  });
  const person = async (label: string, role: ActorRole) => {
    const user = await db.user.create({
      data: {
        organizationId: organization.id,
        email: `${label}-${suffix}@example.test`,
        name: label,
        passwordHash: "test-only",
        role,
      },
    });
    const actor: Actor = { uid: user.id, org: organization.id, role };
    return actor;
  };
  const tech = await person("Tech", "TECHNICIAN");
  const otherTech = await person("OtherTech", "TECHNICIAN");
  const manager = await person("Manager", "MANAGER");
  const experiment = await db.experiment.create({
    data: {
      organizationId: organization.id,
      code: `TRASH-${suffix.slice(0, 8)}`,
      title: "Trashable",
      createdById: tech.uid,
      samples: {
        create: [
          { code: "S1", instrumentCodes: [`ZZ${suffix.slice(0, 4)}-S1`] },
        ],
      },
    },
  });
  return { organization, tech, otherTech, manager, experiment, suffix };
}

describe("experiment recycle bin against PostgreSQL", () => {
  it("trashes on delete, hides everywhere, and restores loss-free", async () => {
    const f = await fixture();
    try {
      await deleteExperiment(f.tech, f.experiment.id);

      // Row still exists, but is invisible to board, designer, and edits.
      const row = await db.experiment.findUniqueOrThrow({
        where: { id: f.experiment.id },
        select: { deletedAt: true, deletedById: true },
      });
      expect(row.deletedAt).not.toBeNull();
      expect(row.deletedById).toBe(f.tech.uid);
      expect(
        (await listDashboardExperiments(f.manager)).some(
          (r) => r.id === f.experiment.id,
        ),
      ).toBe(false);
      expect(
        await getExperimentDesignerData(f.tech, f.experiment.id),
      ).toBeNull();
      await expect(
        updateExperimentMeta(f.tech, f.experiment.id, { title: "zombie" }),
      ).rejects.toThrow(/recycle bin/i);
      await expect(
        duplicateExperiment(f.manager, f.experiment.id),
      ).rejects.toThrow();

      // A trashed experiment's samples no longer answer instrument serials.
      const match = await matchSerial(
        f.organization.id,
        `ZZ${f.suffix.slice(0, 4)}-S1`,
      );
      expect(match.status).not.toBe("MATCHED");

      // The deleter sees it in the bin and restores it, samples intact.
      const bin = await listTrash(f.tech);
      expect(bin.map((r) => r.id)).toContain(f.experiment.id);
      await restoreExperiment(f.tech, f.experiment.id);
      const back = await db.experiment.findUniqueOrThrow({
        where: { id: f.experiment.id },
        select: { deletedAt: true, samples: true },
      });
      expect(back.deletedAt).toBeNull();
      expect(back.samples).toHaveLength(1);
      expect(
        (await listDashboardExperiments(f.manager)).some(
          (r) => r.id === f.experiment.id,
        ),
      ).toBe(true);
      expect(
        await db.auditEvent.count({
          where: {
            organizationId: f.organization.id,
            entityId: f.experiment.id,
            action: { in: ["experiment.trash", "experiment.restore"] },
          },
        }),
      ).toBe(2);
    } finally {
      await removeOrganization(f.organization.id);
    }
  });

  it("scopes the bin and gates restore/purge", async () => {
    const f = await fixture();
    try {
      await deleteExperiment(f.tech, f.experiment.id);

      // An uninvolved technician neither sees nor restores it.
      expect(await listTrash(f.otherTech)).toHaveLength(0);
      await expect(
        restoreExperiment(f.otherTech, f.experiment.id),
      ).rejects.toThrow();

      // Purge is staff-only and irreversible.
      await expect(purgeExperiment(f.tech, f.experiment.id)).rejects.toThrow(
        /staff/i,
      );
      await purgeExperiment(f.manager, f.experiment.id);
      expect(
        await db.experiment.count({ where: { id: f.experiment.id } }),
      ).toBe(0);
      expect(
        await db.auditEvent.count({
          where: {
            organizationId: f.organization.id,
            entityId: f.experiment.id,
            action: "experiment.purge",
          },
        }),
      ).toBe(1);
    } finally {
      await removeOrganization(f.organization.id);
    }
  });

  it("auto-purges entries past retention when the bin is listed", async () => {
    const f = await fixture();
    try {
      await deleteExperiment(f.tech, f.experiment.id);
      await db.experiment.update({
        where: { id: f.experiment.id },
        data: { deletedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) },
      });
      expect(await listTrash(f.manager)).toHaveLength(0);
      expect(
        await db.experiment.count({ where: { id: f.experiment.id } }),
      ).toBe(0);
      expect(
        await db.auditEvent.count({
          where: {
            organizationId: f.organization.id,
            action: "experiment.trash.auto_purged",
          },
        }),
      ).toBe(1);
    } finally {
      await removeOrganization(f.organization.id);
    }
  });
});
