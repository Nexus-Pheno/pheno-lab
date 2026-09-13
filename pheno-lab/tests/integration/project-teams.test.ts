import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/infrastructure/db/client";
import type { Actor, ActorRole } from "@/modules/authorization/actor";
import {
  assignUserProject,
  createProject,
  setProjectActive,
} from "@/modules/experiments/project-service";
import { createExperiment } from "@/modules/experiments/lifecycle-service";

afterAll(async () => {
  await db.$disconnect();
});

async function removeOrganization(organizationId: string): Promise<void> {
  await db.auditEvent.deleteMany({ where: { organizationId } });
  await db.notification.deleteMany({ where: { organizationId } });
  await db.experiment.deleteMany({ where: { organizationId } });
  await db.user.updateMany({
    where: { organizationId },
    data: { projectId: null },
  });
  await db.project.deleteMany({ where: { organizationId } });
  await db.user.deleteMany({ where: { organizationId } });
  await db.organization.delete({ where: { id: organizationId } });
}

async function fixture(slug: string) {
  const suffix = crypto.randomUUID();
  const organization = await db.organization.create({
    data: { name: `Teams ${slug}`, slug: `${slug}-${suffix}` },
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
  return {
    organization,
    admin: await person("Admin", "ADMIN"),
    manager: await person("Manager", "MANAGER"),
    technician: await person("Tech", "TECHNICIAN"),
  };
}

describe("project teams (项目组) against PostgreSQL", () => {
  it("files a new experiment under its creator's team", async () => {
    const f = await fixture("default");
    try {
      const team = await createProject(f.admin, "SAM 材料验证组");
      await assignUserProject(f.admin, {
        userId: f.technician.uid,
        projectId: team.id,
      });
      const filed = await createExperiment(f.technician);
      expect(filed.projectId).toBe(team.id);

      // Ungrouped people start with no team on the experiment.
      const loose = await createExperiment(f.manager);
      expect(loose.projectId).toBeNull();

      // A retired team is not a default any more — the experiment must be
      // filed somewhere current.
      await setProjectActive(f.admin, { id: team.id, active: false });
      const afterRetire = await createExperiment(f.technician);
      expect(afterRetire.projectId).toBeNull();
    } finally {
      await removeOrganization(f.organization.id);
    }
  });

  it("keeps the org chart in the admin's hands and inside the organization", async () => {
    const mine = await fixture("mine");
    const theirs = await fixture("theirs");
    try {
      const team = await createProject(mine.admin, "材料合成");
      await expect(
        assignUserProject(mine.manager, {
          userId: mine.technician.uid,
          projectId: team.id,
        }),
      ).rejects.toThrow();

      const foreign = await createProject(theirs.admin, "Their team");
      await expect(
        assignUserProject(mine.admin, {
          userId: mine.technician.uid,
          projectId: foreign.id,
        }),
      ).rejects.toThrow(/organization/i);
      await expect(
        assignUserProject(mine.admin, {
          userId: theirs.technician.uid,
          projectId: team.id,
        }),
      ).rejects.toThrow(/not found/i);

      await assignUserProject(mine.admin, {
        userId: mine.technician.uid,
        projectId: team.id,
      });
      await assignUserProject(mine.admin, {
        userId: mine.technician.uid,
        projectId: null,
      });
      const row = await db.user.findUniqueOrThrow({
        where: { id: mine.technician.uid },
        select: { projectId: true },
      });
      expect(row.projectId).toBeNull();
      expect(
        await db.auditEvent.count({
          where: {
            organizationId: mine.organization.id,
            action: "project.assign_user",
          },
        }),
      ).toBe(2);
    } finally {
      await removeOrganization(mine.organization.id);
      await removeOrganization(theirs.organization.id);
    }
  });
});
