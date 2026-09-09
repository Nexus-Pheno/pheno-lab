import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/infrastructure/db/client";
import type { Actor, ActorRole } from "@/modules/authorization/actor";
import {
  createProject,
  listProjects,
  renameProject,
  setProjectActive,
} from "@/modules/experiments/project-service";
import {
  sendExperimentToLab,
  updateExperimentMeta,
} from "@/modules/experiments/lifecycle-service";

afterAll(async () => {
  await db.$disconnect();
});

async function removeOrganization(organizationId: string): Promise<void> {
  await db.auditEvent.deleteMany({ where: { organizationId } });
  await db.notification.deleteMany({ where: { organizationId } });
  await db.experiment.deleteMany({ where: { organizationId } });
  await db.project.deleteMany({ where: { organizationId } });
  await db.user.deleteMany({ where: { organizationId } });
  await db.organization.delete({ where: { id: organizationId } });
}

async function fixture(slug: string) {
  const suffix = crypto.randomUUID();
  const organization = await db.organization.create({
    data: { name: `Projects ${slug}`, slug: `${slug}-${suffix}` },
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
  const technician = await person("Tech", "TECHNICIAN");
  const experiment = await db.experiment.create({
    data: {
      organizationId: organization.id,
      code: `PRJ-${suffix.slice(0, 8)}`,
      title: "Untitled experiment",
      createdById: technician.uid,
    },
  });
  return { organization, manager, technician, experiment };
}

describe("projects (课题组) against PostgreSQL", () => {
  it("lets managers curate the list and everyone read it", async () => {
    const f = await fixture("curate");
    try {
      const created = await createProject(f.manager, "SAM 优化");
      // Technicians pick from the list but never edit it.
      await expect(createProject(f.technician, "Shadow")).rejects.toThrow();
      await expect(
        renameProject(f.technician, { id: created.id, name: "Hijack" }),
      ).rejects.toThrow();

      expect((await listProjects(f.technician)).map((p) => p.name)).toEqual([
        "SAM 优化",
      ]);

      // The same name converges on one row instead of failing — two managers
      // filing the same 课题组 must not fork the list.
      const again = await createProject(f.manager, "SAM 优化");
      expect(again.id).toBe(created.id);

      await renameProject(f.manager, { id: created.id, name: "SAM 浓度" });
      // Retiring hides it from the pickers, and staff can still see it.
      await setProjectActive(f.manager, { id: created.id, active: false });
      expect(await listProjects(f.technician)).toHaveLength(0);
      const staffView = await listProjects(f.manager, {
        includeInactive: true,
      });
      expect(staffView).toHaveLength(1);
      expect(staffView[0].name).toBe("SAM 浓度");
      expect(staffView[0].active).toBe(false);

      // A technician cannot widen their own view to the retired rows.
      expect(
        await listProjects(f.technician, { includeInactive: true }),
      ).toHaveLength(0);
    } finally {
      await removeOrganization(f.organization.id);
    }
  });

  it("counts the experiments filed under each project", async () => {
    const f = await fixture("count");
    try {
      const project = await createProject(f.manager, "Blade coating");
      await updateExperimentMeta(f.technician, f.experiment.id, {
        projectId: project.id,
      });
      const [row] = await listProjects(f.technician);
      expect(row.experimentCount).toBe(1);
    } finally {
      await removeOrganization(f.organization.id);
    }
  });

  it("refuses a project belonging to another organization", async () => {
    const mine = await fixture("mine");
    const theirs = await fixture("theirs");
    try {
      const foreign = await createProject(theirs.manager, "Their direction");
      await expect(
        updateExperimentMeta(mine.technician, mine.experiment.id, {
          projectId: foreign.id,
        }),
      ).rejects.toThrow(/organization/i);
      const row = await db.experiment.findUniqueOrThrow({
        where: { id: mine.experiment.id },
        select: { projectId: true },
      });
      expect(row.projectId).toBeNull();
    } finally {
      await removeOrganization(mine.organization.id);
      await removeOrganization(theirs.organization.id);
    }
  });

  it("holds the lab door shut until the draft has a title and a project", async () => {
    const f = await fixture("gate");
    try {
      // Placeholder title: named, not a silent failure.
      expect(await sendExperimentToLab(f.technician, f.experiment.id)).toEqual({
        ok: false,
        blocker: "title",
      });

      await updateExperimentMeta(f.technician, f.experiment.id, {
        title: "SAM 浓度对 PCE 的影响",
      });
      expect(await sendExperimentToLab(f.technician, f.experiment.id)).toEqual({
        ok: false,
        blocker: "project",
      });

      const project = await createProject(f.manager, "SAM 优化");
      await updateExperimentMeta(f.technician, f.experiment.id, {
        projectId: project.id,
      });
      expect(await sendExperimentToLab(f.technician, f.experiment.id)).toEqual({
        ok: true,
      });

      const row = await db.experiment.findUniqueOrThrow({
        where: { id: f.experiment.id },
        select: { status: true },
      });
      expect(row.status).toBe("IN_LAB");
      expect(
        await db.auditEvent.count({
          where: {
            organizationId: f.organization.id,
            entityId: f.experiment.id,
            action: "experiment.update",
          },
        }),
      ).toBeGreaterThan(0);
    } finally {
      await removeOrganization(f.organization.id);
    }
  });

  it("keeps the same gate on the meta path a status change could slip through", async () => {
    const f = await fixture("meta");
    try {
      await expect(
        updateExperimentMeta(f.technician, f.experiment.id, {
          status: "IN_LAB",
        }),
      ).rejects.toThrow(/title/i);

      // Title and project supplied in the same patch pass the gate.
      const project = await createProject(f.manager, "Anti-solvent");
      await updateExperimentMeta(f.technician, f.experiment.id, {
        title: "反溶剂滴加时间",
        projectId: project.id,
        status: "IN_LAB",
      });
      const row = await db.experiment.findUniqueOrThrow({
        where: { id: f.experiment.id },
        select: { status: true, projectId: true },
      });
      expect(row.status).toBe("IN_LAB");
      expect(row.projectId).toBe(project.id);
    } finally {
      await removeOrganization(f.organization.id);
    }
  });

  it("leaves experiments already in the lab alone", async () => {
    const f = await fixture("legacy");
    try {
      // Historical rows carry neither a project nor a meaningful title; the
      // gate is for drafts entering the lab, not a retroactive audit.
      await db.experiment.update({
        where: { id: f.experiment.id },
        data: { status: "IN_LAB" },
      });
      await updateExperimentMeta(f.technician, f.experiment.id, {
        status: "COMPLETE",
      });
      const row = await db.experiment.findUniqueOrThrow({
        where: { id: f.experiment.id },
        select: { status: true },
      });
      expect(row.status).toBe("COMPLETE");
    } finally {
      await removeOrganization(f.organization.id);
    }
  });
});
