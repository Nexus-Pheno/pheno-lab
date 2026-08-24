import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/infrastructure/db/client";
import type { Actor, ActorRole } from "@/modules/authorization/actor";
import { AuthorizationError } from "@/modules/authorization/policy";
import {
  addStep,
  deleteExperiment,
  updateExperimentMeta,
} from "@/modules/experiments/service";
import { getOrCreateRunService } from "@/modules/runs/service";

/**
 * The write half of the permission matrix.
 *
 * `authorization.test.ts` proves the read scope never leaks across
 * organizations. These cases cover what that scope cannot: a caller who
 * already holds a valid experiment id and tries to mutate it. A regression
 * here does not crash — it silently lets the wrong person edit research
 * facts — so every case asserts both the rejection and that nothing changed.
 */

afterAll(async () => {
  await db.$disconnect();
});

async function removeOrganization(organizationId: string): Promise<void> {
  await db.auditEvent.deleteMany({ where: { organizationId } });
  await db.experiment.deleteMany({ where: { organizationId } });
  await db.process.deleteMany({ where: { organizationId } });
  await db.user.deleteMany({ where: { organizationId } });
  await db.organization.delete({ where: { id: organizationId } });
}

async function createOrganization(prefix: string) {
  const suffix = crypto.randomUUID();
  return db.organization.create({
    data: { name: `${prefix} Org`, slug: `${prefix}-${suffix}` },
  });
}

async function createUser(
  organizationId: string,
  role: ActorRole,
  label: string,
): Promise<Actor> {
  const user = await db.user.create({
    data: {
      organizationId,
      email: `${label}-${crypto.randomUUID()}@example.test`,
      name: label,
      passwordHash: "test-only",
      role,
    },
  });
  return { uid: user.id, org: organizationId, role };
}

async function createExperiment(
  organizationId: string,
  createdById: string,
  memberIds: string[] = [],
) {
  return db.experiment.create({
    data: {
      organizationId,
      code: `EXP-${crypto.randomUUID().slice(0, 8)}`,
      title: "Baseline title",
      createdById,
      members: { create: memberIds.map((userId) => ({ userId })) },
    },
  });
}

/** Asserts the call was refused *and* left no trace. */
async function expectRefused(
  attempt: Promise<unknown>,
  experimentId: string,
): Promise<void> {
  await expect(attempt).rejects.toBeInstanceOf(AuthorizationError);
  const after = await db.experiment.findUnique({
    where: { id: experimentId },
    select: { title: true },
  });
  expect(after?.title).toBe("Baseline title");
  expect(await db.auditEvent.count({ where: { entityId: experimentId } })).toBe(
    0,
  );
}

describe("cross-organization writes", () => {
  it("refuses update and delete from an admin of another organization", async () => {
    const home = await createOrganization("write-home");
    const foreign = await createOrganization("write-foreign");
    try {
      const owner = await createUser(home.id, "MANAGER", "home-manager");
      const intruder = await createUser(foreign.id, "ADMIN", "foreign-admin");
      const experiment = await createExperiment(home.id, owner.uid);

      // An org admin passes the staff check, so only the organization
      // comparison stands between them and another lab's data.
      await expectRefused(
        updateExperimentMeta(intruder, experiment.id, {
          title: "Hijacked",
        }),
        experiment.id,
      );

      await expectRefused(
        deleteExperiment(intruder, experiment.id),
        experiment.id,
      );

      expect(await db.experiment.count({ where: { id: experiment.id } })).toBe(
        1,
      );
    } finally {
      await removeOrganization(home.id);
      await removeOrganization(foreign.id);
    }
  });
});

describe("manager scope inside one organization", () => {
  it("limits managers to experiments they created or belong to", async () => {
    const organization = await createOrganization("manager-scope");
    try {
      const creator = await createUser(organization.id, "MANAGER", "creator");
      const member = await createUser(organization.id, "MANAGER", "member");
      const outsider = await createUser(organization.id, "MANAGER", "outsider");
      const admin = await createUser(organization.id, "ADMIN", "admin");
      const experiment = await createExperiment(organization.id, creator.uid, [
        member.uid,
      ]);

      // Same organization, same role — membership is the only difference.
      await expectRefused(
        updateExperimentMeta(outsider, experiment.id, { title: "Outsider" }),
        experiment.id,
      );

      await updateExperimentMeta(creator, experiment.id, {
        title: "By creator",
      });
      await updateExperimentMeta(member, experiment.id, { title: "By member" });
      await updateExperimentMeta(admin, experiment.id, { title: "By admin" });

      const after = await db.experiment.findUniqueOrThrow({
        where: { id: experiment.id },
        select: { title: true },
      });
      expect(after.title).toBe("By admin");
      expect(
        await db.auditEvent.count({
          where: { entityId: experiment.id, action: "experiment.update" },
        }),
      ).toBe(3);
    } finally {
      await removeOrganization(organization.id);
    }
  });
});

describe("technician write boundary", () => {
  it("blocks plan edits but allows capture on an assigned experiment", async () => {
    const organization = await createOrganization("technician-boundary");
    try {
      const manager = await createUser(organization.id, "MANAGER", "owner");
      const technician = await createUser(
        organization.id,
        "TECHNICIAN",
        "assigned-tech",
      );
      const experiment = await createExperiment(organization.id, manager.uid, [
        technician.uid,
      ]);
      const process = await db.process.create({
        data: {
          organizationId: organization.id,
          name: "Anneal",
          kind: "PROCESSING",
          icon: "FlaskConical",
        },
      });

      // The technician is a member: they can read and capture, but the plan
      // itself stays read-only for them.
      await expectRefused(
        updateExperimentMeta(technician, experiment.id, { title: "Edited" }),
        experiment.id,
      );

      await expectRefused(
        addStep(technician, experiment.id, process.id),
        experiment.id,
      );

      await expectRefused(
        deleteExperiment(technician, experiment.id),
        experiment.id,
      );

      expect(
        await db.processStep.count({ where: { experimentId: experiment.id } }),
      ).toBe(0);

      // The same actor may still open a run — capture is the one write a
      // technician owns.
      const run = await getOrCreateRunService(technician, experiment.id);
      expect(run.experimentId).toBe(experiment.id);
      expect(run.technicianId).toBe(technician.uid);
    } finally {
      await removeOrganization(organization.id);
    }
  });

  it("refuses capture for a technician who is not a member", async () => {
    const organization = await createOrganization("technician-unassigned");
    try {
      const manager = await createUser(organization.id, "MANAGER", "owner");
      const stranger = await createUser(
        organization.id,
        "TECHNICIAN",
        "unassigned-tech",
      );
      const experiment = await createExperiment(organization.id, manager.uid);

      await expect(
        getOrCreateRunService(stranger, experiment.id),
      ).rejects.toBeInstanceOf(AuthorizationError);
      expect(
        await db.run.count({ where: { experimentId: experiment.id } }),
      ).toBe(0);
    } finally {
      await removeOrganization(organization.id);
    }
  });
});
