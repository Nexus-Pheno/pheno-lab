import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/infrastructure/db/client";
import type { Actor, ActorRole } from "@/modules/authorization/actor";
import {
  renewIdleDraft,
  sweepIdleDrafts,
} from "@/modules/experiments/idle-service";

afterAll(async () => {
  await db.$disconnect();
});

const day = 24 * 3_600_000;

async function removeOrganization(organizationId: string): Promise<void> {
  await db.auditEvent.deleteMany({ where: { organizationId } });
  await db.notification.deleteMany({ where: { organizationId } });
  await db.experiment.deleteMany({ where: { organizationId } });
  await db.user.deleteMany({ where: { organizationId } });
  await db.organization.delete({ where: { id: organizationId } });
}

async function fixture(slug: string) {
  const suffix = crypto.randomUUID();
  const organization = await db.organization.create({
    data: { name: `Idle ${slug}`, slug: `${slug}-${suffix}` },
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
  const owner = await person("Owner", "TECHNICIAN");
  const other = await person("Other", "TECHNICIAN");
  /** A draft whose last edit was `idleDays` ago. */
  const draft = async (
    label: string,
    idleDays: number,
    over: {
      status?: "DRAFT" | "IN_LAB";
      isTest?: boolean;
      deleted?: boolean;
    } = {},
  ) =>
    db.experiment.create({
      data: {
        organizationId: organization.id,
        code: `IDLE-${label}-${suffix.slice(0, 6)}`,
        title: "Untitled experiment",
        createdById: owner.uid,
        status: over.status ?? "DRAFT",
        isTest: over.isTest ?? false,
        deletedAt: over.deleted ? new Date() : null,
        updatedAt: new Date(Date.now() - idleDays * day),
      },
    });
  return { organization, owner, other, draft };
}

const stateOf = (id: string) =>
  db.experiment.findUniqueOrThrow({
    where: { id },
    select: {
      status: true,
      idleWarnedAt: true,
      idleArchivedAt: true,
      updatedAt: true,
    },
  });

describe("idle-draft sweep against PostgreSQL", () => {
  it("warns at 7 idle days, once, and tells the creator", async () => {
    const f = await fixture("warn");
    try {
      const fresh = await f.draft("fresh", 2);
      const stale = await f.draft("stale", 8);
      const before = (await stateOf(stale.id)).updatedAt;

      const first = await sweepIdleDrafts();
      expect(first.warned).toBeGreaterThanOrEqual(1);
      expect((await stateOf(fresh.id)).idleWarnedAt).toBeNull();
      const warned = await stateOf(stale.id);
      expect(warned.idleWarnedAt).not.toBeNull();
      expect(warned.status).toBe("DRAFT");
      // Housekeeping is not activity: the row's own clock did not move.
      expect(warned.updatedAt.getTime()).toBe(before.getTime());

      const notice = await db.notification.findFirst({
        where: { userId: f.owner.uid, kind: "draft_idle_warning" },
      });
      expect(notice?.href).toBe(`/experiments/${stale.id}`);

      // The next night: still warned, not warned again, not archived yet.
      await sweepIdleDrafts();
      expect(
        await db.notification.count({
          where: { userId: f.owner.uid, kind: "draft_idle_warning" },
        }),
      ).toBe(1);
      expect((await stateOf(stale.id)).status).toBe("DRAFT");
    } finally {
      await removeOrganization(f.organization.id);
    }
  });

  it("archives 3 days after the warning once 10 days idle, and one click renews it", async () => {
    const f = await fixture("archive");
    try {
      const stale = await f.draft("stale", 12);
      // Warned 4 days ago.
      await db.experiment.update({
        where: { id: stale.id },
        data: {
          idleWarnedAt: new Date(Date.now() - 4 * day),
          updatedAt: stale.updatedAt,
        },
      });
      const result = await sweepIdleDrafts();
      expect(result.archived).toBeGreaterThanOrEqual(1);
      const archived = await stateOf(stale.id);
      expect(archived.status).toBe("ARCHIVED");
      expect(archived.idleArchivedAt).not.toBeNull();
      expect(
        await db.notification.count({
          where: { userId: f.owner.uid, kind: "draft_idle_archived" },
        }),
      ).toBe(1);
      expect(
        await db.auditEvent.count({
          where: {
            entityId: stale.id,
            action: "experiment.idle_archived",
            actorType: "SYSTEM",
          },
        }),
      ).toBe(1);

      // Someone else's experiment is not theirs to renew.
      await expect(renewIdleDraft(f.other, stale.id)).rejects.toThrow();
      await renewIdleDraft(f.owner, stale.id);
      const renewed = await stateOf(stale.id);
      expect(renewed.status).toBe("DRAFT");
      expect(renewed.idleArchivedAt).toBeNull();
      expect(renewed.idleWarnedAt).toBeNull();
      // The renewal itself is activity: the sweep leaves it alone now.
      await sweepIdleDrafts();
      expect((await stateOf(stale.id)).idleWarnedAt).toBeNull();

      // A deliberate archive is not renewable through this door.
      const deliberate = await f.draft("deliberate", 1);
      await db.experiment.update({
        where: { id: deliberate.id },
        data: { status: "ARCHIVED" },
      });
      await expect(renewIdleDraft(f.owner, deliberate.id)).rejects.toThrow(
        /inactivity/i,
      );
    } finally {
      await removeOrganization(f.organization.id);
    }
  });

  it("does not archive a warned draft before its 3 days are up", async () => {
    const f = await fixture("grace");
    try {
      const stale = await f.draft("stale", 30);
      await db.experiment.update({
        where: { id: stale.id },
        data: {
          idleWarnedAt: new Date(Date.now() - 1 * day),
          updatedAt: stale.updatedAt,
        },
      });
      await sweepIdleDrafts();
      expect((await stateOf(stale.id)).status).toBe("DRAFT");
    } finally {
      await removeOrganization(f.organization.id);
    }
  });

  it("counts an edit on a step as activity and clears the warning", async () => {
    const f = await fixture("reset");
    try {
      const stale = await f.draft("stale", 9);
      await db.experiment.update({
        where: { id: stale.id },
        data: {
          idleWarnedAt: new Date(Date.now() - 1 * day),
          updatedAt: stale.updatedAt,
        },
      });
      const process = await db.process.create({
        data: {
          organizationId: f.organization.id,
          name: "Coat",
          position: 0,
          kind: "PROCESSING",
        },
      });
      const step = await db.processStep.create({
        data: {
          experimentId: stale.id,
          processId: process.id,
          position: 0,
          name: "Coat",
        },
      });
      // The designer audits step edits against the step, not the experiment.
      await db.auditEvent.create({
        data: {
          organizationId: f.organization.id,
          actorType: "USER",
          actorUserId: f.owner.uid,
          action: "experiment.step.updated",
          entityType: "ProcessStep",
          entityId: step.id,
        },
      });
      const result = await sweepIdleDrafts();
      expect(result.reset).toBeGreaterThanOrEqual(1);
      expect((await stateOf(stale.id)).idleWarnedAt).toBeNull();
    } finally {
      // Steps reference the process: experiments go first, then the process.
      await db.experiment.deleteMany({
        where: { organizationId: f.organization.id },
      });
      await db.process.deleteMany({
        where: { organizationId: f.organization.id },
      });
      await removeOrganization(f.organization.id);
    }
  });

  it("leaves the lab, the sandbox and the recycle bin alone", async () => {
    const f = await fixture("skip");
    try {
      const inLab = await f.draft("lab", 40, { status: "IN_LAB" });
      const sandbox = await f.draft("test", 40, { isTest: true });
      const trashed = await f.draft("trash", 40, { deleted: true });
      await sweepIdleDrafts();
      for (const row of [inLab, sandbox, trashed]) {
        const state = await stateOf(row.id);
        expect(state.idleWarnedAt).toBeNull();
        expect(state.idleArchivedAt).toBeNull();
      }
    } finally {
      await removeOrganization(f.organization.id);
    }
  });
});
