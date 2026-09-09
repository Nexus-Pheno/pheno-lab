import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/infrastructure/db/client";
import type { Actor, ActorRole } from "@/modules/authorization/actor";
import { loadAnalysisDataset } from "@/modules/analysis/query";
import { buildTidyCsv } from "@/modules/analysis/export-service";

afterAll(async () => {
  await db.$disconnect();
});

async function removeOrganization(organizationId: string): Promise<void> {
  await db.auditEvent.deleteMany({ where: { organizationId } });
  await db.notification.deleteMany({ where: { organizationId } });
  await db.experiment.deleteMany({ where: { organizationId } });
  await db.project.deleteMany({ where: { organizationId } });
  await db.process.deleteMany({ where: { organizationId } });
  await db.user.deleteMany({ where: { organizationId } });
  await db.organization.delete({ where: { id: organizationId } });
}

/**
 * One experiment that varied a single condition across two groups, with a
 * measured PCE per sample — the smallest thing the analysis can compare.
 */
async function seedExperiment(opts: {
  organizationId: string;
  ownerId: string;
  processId: string;
  code: string;
  title: string;
  values: Record<string, string>;
  pce: Record<string, number>;
  isTest?: boolean;
  deleted?: boolean;
}) {
  const experiment = await db.experiment.create({
    data: {
      organizationId: opts.organizationId,
      code: opts.code,
      title: opts.title,
      createdById: opts.ownerId,
      isTest: opts.isTest ?? false,
      deletedAt: opts.deleted ? new Date() : null,
      samples: {
        create: Object.keys(opts.pce).map((code) => ({
          code,
          variationGroup: code.startsWith("A") ? "A" : "B",
        })),
      },
      steps: {
        create: [
          {
            position: 0,
            name: "Coating",
            processId: opts.processId,
            parameters: {
              create: [
                {
                  position: 0,
                  name: "Coating method",
                  unit: "",
                  value: "",
                  variations: {
                    create: Object.entries(opts.values).map(
                      ([variationGroup, value]) => ({ variationGroup, value }),
                    ),
                  },
                },
              ],
            },
          },
        ],
      },
      characterizations: {
        create: [{ position: 0, name: "J-V", processId: opts.processId }],
      },
    },
    include: { samples: true, characterizations: true },
  });

  for (const sample of experiment.samples) {
    await db.characterizationResult.create({
      data: {
        characterizationId: experiment.characterizations[0].id,
        sampleId: sample.id,
        metrics: { "PCE (%)": String(opts.pce[sample.code]) },
      },
    });
  }
  return experiment;
}

async function fixture(slug: string) {
  const suffix = crypto.randomUUID();
  const organization = await db.organization.create({
    data: { name: `Analysis ${slug}`, slug: `${slug}-${suffix}` },
  });
  const person = async (label: string, role: ActorRole): Promise<Actor> => {
    const user = await db.user.create({
      data: {
        organizationId: organization.id,
        email: `${label}-${suffix}@example.test`,
        name: label,
        passwordHash: "test-only",
        role,
      },
    });
    return { uid: user.id, org: organization.id, role };
  };
  const manager = await person("Manager", "MANAGER");
  const outsider = await person("Outsider", "TECHNICIAN");
  const process = await db.process.create({
    data: {
      organizationId: organization.id,
      name: "Coating",
      position: 0,
      kind: "PROCESSING",
    },
  });
  return { organization, manager, outsider, process, suffix };
}

describe("cross-experiment analysis against PostgreSQL", () => {
  it("pools conditions across experiments a technician cannot even open", async () => {
    const f = await fixture("scope");
    try {
      // Both experiments belong to the manager. The technician is not a
      // member of either and cannot open them.
      await seedExperiment({
        organizationId: f.organization.id,
        ownerId: f.manager.uid,
        processId: f.process.id,
        code: `AN-${f.suffix.slice(0, 6)}-1`,
        title: "Batch one",
        values: { A: "spin", B: "blade" },
        pce: { A1: 20, A2: 20.4, B1: 22, B2: 22.6 },
      });
      await seedExperiment({
        organizationId: f.organization.id,
        ownerId: f.manager.uid,
        processId: f.process.id,
        code: `AN-${f.suffix.slice(0, 6)}-2`,
        title: "Batch two",
        values: { A: "spin", B: "blade" },
        pce: { A1: 19, A2: 19.2, B1: 21, B2: 21.4 },
      });

      // The deliberate widening (Michael, 2026-09-09): analysis is org-wide
      // for every role, so a technician gets the whole lab's evidence.
      const dataset = await loadAnalysisDataset(f.outsider, { metric: "pce" });
      expect(dataset.experiments).toBe(2);
      expect(dataset.samplesWithData).toBe(8);

      const condition = dataset.conditions.find(
        (c) => c.label === "Coating method",
      );
      expect(condition).toBeDefined();
      expect(condition!.experiments).toBe(2);
      expect(condition!.values).toEqual(["blade", "spin"]);

      // …and the widening stops at the analysis surface: the experiment
      // itself is still closed to them.
      const openable = await db.experiment.findFirst({
        where: {
          organizationId: f.organization.id,
          OR: [
            { createdById: f.outsider.uid },
            { members: { some: { userId: f.outsider.uid } } },
          ],
        },
      });
      expect(openable).toBeNull();
    } finally {
      await removeOrganization(f.organization.id);
    }
  });

  it("leaves out test experiments and the recycle bin", async () => {
    const f = await fixture("excluded");
    try {
      await seedExperiment({
        organizationId: f.organization.id,
        ownerId: f.manager.uid,
        processId: f.process.id,
        code: `AN-${f.suffix.slice(0, 6)}-T`,
        title: "Sandbox",
        values: { A: "spin", B: "blade" },
        pce: { A1: 30, B1: 31 },
        isTest: true,
      });
      await seedExperiment({
        organizationId: f.organization.id,
        ownerId: f.manager.uid,
        processId: f.process.id,
        code: `AN-${f.suffix.slice(0, 6)}-D`,
        title: "Trashed",
        values: { A: "spin", B: "blade" },
        pce: { A1: 40, B1: 41 },
        deleted: true,
      });
      const dataset = await loadAnalysisDataset(f.manager, { metric: "pce" });
      expect(dataset.experiments).toBe(0);
      expect(dataset.rows).toHaveLength(0);
    } finally {
      await removeOrganization(f.organization.id);
    }
  });

  it("never reaches into another organization", async () => {
    const mine = await fixture("mine");
    const theirs = await fixture("theirs");
    try {
      await seedExperiment({
        organizationId: theirs.organization.id,
        ownerId: theirs.manager.uid,
        processId: theirs.process.id,
        code: `AN-${theirs.suffix.slice(0, 6)}-X`,
        title: "Their batch",
        values: { A: "spin", B: "blade" },
        pce: { A1: 25, B1: 26 },
      });
      const dataset = await loadAnalysisDataset(mine.manager, {
        metric: "pce",
      });
      expect(dataset.experiments).toBe(0);
    } finally {
      await removeOrganization(mine.organization.id);
      await removeOrganization(theirs.organization.id);
    }
  });

  it("exports the same rows it displays, and audits the download", async () => {
    const f = await fixture("csv");
    try {
      await seedExperiment({
        organizationId: f.organization.id,
        ownerId: f.manager.uid,
        processId: f.process.id,
        code: `AN-${f.suffix.slice(0, 6)}-C`,
        title: "Exportable",
        values: { A: "spin", B: "blade" },
        pce: { A1: 20, B1: 22 },
      });
      const result = await buildTidyCsv(f.outsider, { metric: "pce" });
      expect(result.rows).toBe(2);
      const [header, ...lines] = result.csv.split("\n");
      expect(header).toContain('"Coating · Coating method"');
      expect(header).toContain('"PCE"');
      expect(lines).toHaveLength(2);
      expect(result.csv).toContain('"spin"');
      expect(result.csv).toContain('"blade"');

      expect(
        await db.auditEvent.count({
          where: {
            organizationId: f.organization.id,
            action: "analysis.exported",
          },
        }),
      ).toBe(1);
    } finally {
      await removeOrganization(f.organization.id);
    }
  });
});
