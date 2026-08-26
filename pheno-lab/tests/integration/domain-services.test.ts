import { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/infrastructure/db/client";
import type { Actor } from "@/modules/authorization/actor";
import { duplicateExperiment } from "@/modules/experiments/service";
import { publishIngestItem } from "@/modules/ingest/service";
import { getDatabaseSummary } from "@/modules/insights/query";
import { createEquipment } from "@/modules/library/service";

afterAll(async () => {
  await db.$disconnect();
});

async function removeOrganization(organizationId: string): Promise<void> {
  await db.auditEvent.deleteMany({ where: { organizationId } });
  await db.ingestItem.deleteMany({ where: { organizationId } });
  await db.experiment.deleteMany({ where: { organizationId } });
  await db.equipment.deleteMany({ where: { organizationId } });
  await db.process.deleteMany({ where: { organizationId } });
  await db.material.deleteMany({ where: { organizationId } });
  await db.label.deleteMany({ where: { organizationId } });
  await db.user.deleteMany({ where: { organizationId } });
  await db.organization.delete({ where: { id: organizationId } });
}

async function organizationWithAdmin(prefix: string) {
  const suffix = crypto.randomUUID();
  const organization = await db.organization.create({
    data: { name: `${prefix} Org`, slug: `${prefix}-${suffix}` },
  });
  const user = await db.user.create({
    data: {
      organizationId: organization.id,
      email: `${prefix}-${suffix}@example.test`,
      name: `${prefix} Admin`,
      passwordHash: "test-only",
      role: "ADMIN",
    },
  });
  const actor: Actor = {
    uid: user.id,
    org: organization.id,
    role: "ADMIN",
  };
  return { actor, organization, user };
}

describe("domain service integrity", () => {
  it("rejects cross-organization foreign keys before creating library data", async () => {
    const orgA = await organizationWithAdmin("library-a");
    const orgB = await organizationWithAdmin("library-b");
    try {
      const foreignProcess = await db.process.create({
        data: {
          organizationId: orgB.organization.id,
          name: "Foreign process",
          kind: "PROCESSING",
          icon: "FlaskConical",
        },
      });

      await expect(
        createEquipment(orgA.actor, {
          processId: foreignProcess.id,
          name: "Cross-org equipment",
          make: "",
          model: "",
          assetTag: "",
          locationId: null,
          photoPath: "",
          parameters: [],
        }),
      ).rejects.toThrow(/this organization/i);
      expect(
        await db.equipment.count({
          where: { organizationId: orgA.organization.id },
        }),
      ).toBe(0);
      expect(
        await db.auditEvent.count({
          where: {
            organizationId: orgA.organization.id,
            action: "library.equipment.created",
          },
        }),
      ).toBe(0);
    } finally {
      await removeOrganization(orgA.organization.id);
      await removeOrganization(orgB.organization.id);
    }
  });

  it("publishes one queue item exactly once with its audit event", async () => {
    const fixture = await organizationWithAdmin("ingest-atomic");
    const name = `Atomic material ${crypto.randomUUID()}`;
    try {
      const item = await db.ingestItem.create({
        data: {
          organizationId: fixture.organization.id,
          kind: "MATERIAL",
          title: name,
          payload: { name } as Prisma.InputJsonValue,
        },
      });

      const attempts = await Promise.allSettled([
        publishIngestItem(fixture.actor, item.id, { name }, "reviewed", {
          mode: "CREATE_ANYWAY",
        }),
        publishIngestItem(fixture.actor, item.id, { name }, "reviewed", {
          mode: "CREATE_ANYWAY",
        }),
      ]);
      const failures = attempts.flatMap((attempt) =>
        attempt.status === "rejected" ? [String(attempt.reason)] : [],
      );

      expect(
        attempts.filter((attempt) => attempt.status === "fulfilled"),
        failures.join("\n"),
      ).toHaveLength(1);
      expect(
        attempts.filter((attempt) => attempt.status === "rejected"),
      ).toHaveLength(1);
      const published = await db.ingestItem.findUniqueOrThrow({
        where: { id: item.id },
      });
      expect(published.status).toBe("PUBLISHED");
      expect(published.publishedId).toBeTruthy();
      expect(
        await db.material.count({
          where: { organizationId: fixture.organization.id, name },
        }),
      ).toBe(1);
      expect(
        await db.auditEvent.count({
          where: {
            organizationId: fixture.organization.id,
            action: "ingest.item.published",
            entityId: item.id,
          },
        }),
      ).toBe(1);
    } finally {
      await removeOrganization(fixture.organization.id);
    }
  });

  it("duplicates an experiment plan without copying execution data or serial identity", async () => {
    const fixture = await organizationWithAdmin("experiment-copy");
    try {
      const [process, characterizationProcess] = await Promise.all([
        db.process.create({
          data: {
            organizationId: fixture.organization.id,
            name: "Copy processing",
            kind: "PROCESSING",
            icon: "Layers",
          },
        }),
        db.process.create({
          data: {
            organizationId: fixture.organization.id,
            name: "Copy characterization",
            kind: "CHARACTERIZATION",
            icon: "ChartNoAxesCombined",
          },
        }),
      ]);
      const source = await db.experiment.create({
        data: {
          organizationId: fixture.organization.id,
          code: `SOURCE-${crypto.randomUUID()}`,
          title: "Source plan",
          createdById: fixture.user.id,
          samples: {
            create: [{ code: "S1", instrumentCodes: ["E999-S1"] }],
          },
          steps: {
            create: {
              position: 0,
              processId: process.id,
              name: "Spin",
              parameters: {
                create: {
                  position: 0,
                  name: "Speed",
                  unit: "rpm",
                  value: "3000",
                  source: "process",
                },
              },
            },
          },
          characterizations: {
            create: {
              position: 0,
              processId: characterizationProcess.id,
              name: "J-V",
            },
          },
          runs: { create: { runNo: 1, status: "DONE" } },
        },
      });

      const copied = await duplicateExperiment(fixture.actor, source.id);
      const copy = await db.experiment.findUniqueOrThrow({
        where: { id: copied.id },
        include: {
          samples: true,
          steps: { include: { parameters: true } },
          characterizations: true,
          runs: true,
        },
      });
      expect(copy.code).not.toBe(source.code);
      expect(copy.steps).toHaveLength(1);
      expect(copy.steps[0].parameters).toHaveLength(1);
      expect(copy.characterizations).toHaveLength(1);
      expect(copy.runs).toHaveLength(0);
      expect(copy.samples[0].instrumentCodes[0]).toMatch(/^E\d+-S1$/);
      expect(copy.samples[0].instrumentCodes).not.toContain("E999-S1");
      expect(
        await db.auditEvent.count({
          where: {
            organizationId: fixture.organization.id,
            entityId: copy.id,
            action: "experiment.duplicate",
          },
        }),
      ).toBe(1);
    } finally {
      await removeOrganization(fixture.organization.id);
    }
  });

  it("computes experiment aggregates from the actor's visibility scope", async () => {
    const suffix = crypto.randomUUID();
    const organization = await db.organization.create({
      data: { name: "Summary Org", slug: `summary-${suffix}` },
    });
    const [manager, otherManager] = await Promise.all([
      db.user.create({
        data: {
          organizationId: organization.id,
          email: `summary-manager-${suffix}@example.test`,
          name: "Visible Manager",
          passwordHash: "test-only",
          role: "MANAGER",
        },
      }),
      db.user.create({
        data: {
          organizationId: organization.id,
          email: `summary-other-${suffix}@example.test`,
          name: "Other Manager",
          passwordHash: "test-only",
          role: "MANAGER",
        },
      }),
    ]);
    try {
      await Promise.all([
        db.experiment.create({
          data: {
            organizationId: organization.id,
            code: `VISIBLE-${suffix}`,
            title: "Visible experiment",
            createdById: manager.id,
            samples: { create: [{ code: "S1" }] },
          },
        }),
        db.experiment.create({
          data: {
            organizationId: organization.id,
            code: `HIDDEN-${suffix}`,
            title: "Hidden experiment",
            createdById: otherManager.id,
            samples: { create: [{ code: "S1" }, { code: "S2" }] },
          },
        }),
        db.experiment.create({
          data: {
            organizationId: organization.id,
            code: `HIDDEN-TEST-${suffix}`,
            title: "Hidden test experiment",
            isTest: true,
            createdById: otherManager.id,
          },
        }),
      ]);

      const summary = await getDatabaseSummary({
        uid: manager.id,
        org: organization.id,
        role: "MANAGER",
      });
      expect(summary.experiments).toBe(1);
      expect(summary.samples).toBe(1);
      expect(summary.testExperiments).toBe(0);
    } finally {
      await removeOrganization(organization.id);
    }
  });

  it("attaches equipment spec sheets on publish without stacking duplicates", async () => {
    const fixture = await organizationWithAdmin("equip-docs");
    try {
      const process = await db.process.create({
        data: {
          organizationId: fixture.organization.id,
          name: "XRD",
          kind: "CHARACTERIZATION",
          icon: "Wrench",
        },
      });
      const manual = {
        fileName: "MiniFlex600 规格书.pdf",
        storedPath: `organizations/${fixture.organization.id}/documents/miniflex.pdf`,
        mime: "application/pdf",
        size: 4096,
      };
      const payload = {
        name: "Rigaku XRD",
        make: "Rigaku",
        model: "MiniFlex600",
        processName: process.name,
        documents: [manual],
      };
      const staged = async () =>
        db.ingestItem.create({
          data: {
            organizationId: fixture.organization.id,
            kind: "EQUIPMENT",
            title: "Rigaku XRD",
            payload: payload as Prisma.InputJsonValue,
          },
        });

      const first = await staged();
      await publishIngestItem(fixture.actor, first.id, payload, "reviewed", {
        mode: "AUTO",
      });
      const equipment = await db.equipment.findFirstOrThrow({
        where: { organizationId: fixture.organization.id },
        include: { attachments: true },
      });
      expect(equipment.attachments).toHaveLength(1);
      expect(equipment.attachments[0].fileName).toBe(manual.fileName);
      expect(equipment.attachments[0].storedPath).toBe(manual.storedPath);

      // Publishing the same sheet onto the same machine again must not stack a
      // second row — spec sheets are re-sent whenever a record is re-reviewed.
      const second = await staged();
      await publishIngestItem(fixture.actor, second.id, payload, "reviewed", {
        mode: "UPDATE",
        targetId: equipment.id,
      });
      expect(
        await db.attachment.count({ where: { equipmentId: equipment.id } }),
      ).toBe(1);

      // Deleting the machine takes its documents with it.
      await db.equipment.delete({ where: { id: equipment.id } });
      expect(
        await db.attachment.count({ where: { equipmentId: equipment.id } }),
      ).toBe(0);
    } finally {
      await removeOrganization(fixture.organization.id);
    }
  });

  it("adds detail and a manual to an existing environment without erasing its conditions", async () => {
    const fixture = await organizationWithAdmin("env-docs");
    try {
      const conditions = [
        { name: "O₂", unit: "ppm", defaultValue: "<0.01" },
        { name: "H₂O", unit: "ppm", defaultValue: "<0.01" },
      ];
      const environment = await db.labEnvironment.create({
        data: {
          organizationId: fixture.organization.id,
          name: "Glovebox N₂ (Mikrouna)",
          conditions: conditions as Prisma.InputJsonValue,
        },
      });
      expect(environment.notes).toBe("");

      const manual = {
        fileName: "手套箱-说明书.pdf",
        storedPath: `organizations/${fixture.organization.id}/documents/glovebox.pdf`,
        mime: "application/pdf",
        size: 8192,
      };
      // The draft deliberately carries no conditions: a record that only adds
      // detail must not wipe the readings operators already record.
      const payload = {
        name: environment.name,
        notes: "Mikrouna Inpure, three 2440 mm chambers.",
        documents: [manual],
      };
      const staged = async () =>
        db.ingestItem.create({
          data: {
            organizationId: fixture.organization.id,
            kind: "ENVIRONMENT",
            title: environment.name,
            payload: payload as Prisma.InputJsonValue,
          },
        });

      const first = await staged();
      await publishIngestItem(fixture.actor, first.id, payload, "reviewed", {
        mode: "UPDATE",
        targetId: environment.id,
      });
      const updated = await db.labEnvironment.findUniqueOrThrow({
        where: { id: environment.id },
        include: { attachments: true },
      });
      expect(updated.notes).toContain("Mikrouna Inpure");
      expect(updated.conditions).toEqual(conditions);
      expect(updated.attachments).toHaveLength(1);
      expect(updated.attachments[0].fileName).toBe(manual.fileName);

      const second = await staged();
      await publishIngestItem(fixture.actor, second.id, payload, "reviewed", {
        mode: "UPDATE",
        targetId: environment.id,
      });
      expect(
        await db.attachment.count({
          where: { labEnvironmentId: environment.id },
        }),
      ).toBe(1);
    } finally {
      await db.labEnvironment.deleteMany({
        where: { organizationId: fixture.organization.id },
      });
      await removeOrganization(fixture.organization.id);
    }
  });
});
