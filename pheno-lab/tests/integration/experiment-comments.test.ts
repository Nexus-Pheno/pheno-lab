import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/infrastructure/db/client";
import type { Actor, ActorRole } from "@/modules/authorization/actor";
import {
  addComment,
  deleteComment,
  listComments,
} from "@/modules/experiments/comment-service";

afterAll(async () => {
  await db.$disconnect();
});

async function removeOrganization(organizationId: string): Promise<void> {
  await db.auditEvent.deleteMany({ where: { organizationId } });
  await db.notification.deleteMany({ where: { organizationId } });
  await db.experiment.deleteMany({ where: { organizationId } });
  await db.user.deleteMany({ where: { organizationId } });
  await db.organization.delete({ where: { id: organizationId } });
}

async function fixture() {
  const suffix = crypto.randomUUID();
  const organization = await db.organization.create({
    data: { name: "Comments Org", slug: `comments-${suffix}` },
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
  const owner = await person("Owner", "TECHNICIAN");
  const member = await person("Member", "TECHNICIAN");
  const member2 = await person("Member2", "TECHNICIAN");
  const outsider = await person("Outsider", "TECHNICIAN");
  const manager = await person("Manager", "MANAGER");
  const experiment = await db.experiment.create({
    data: {
      organizationId: organization.id,
      code: `CMT-${suffix.slice(0, 8)}`,
      title: "Discussion test",
      createdById: owner.uid,
      members: { create: [{ userId: member.uid }, { userId: member2.uid }] },
    },
  });
  return {
    organization,
    owner,
    member,
    member2,
    outsider,
    manager,
    experiment,
  };
}

describe("experiment comments against PostgreSQL", () => {
  it("gates commenting on read access and notifies owner + mentions once", async () => {
    const f = await fixture();
    try {
      // An uninvolved technician can neither read nor write the thread.
      await expect(listComments(f.outsider, f.experiment.id)).rejects.toThrow();
      await expect(
        addComment(f.outsider, {
          experimentId: f.experiment.id,
          body: "sneaky",
          mentionIds: [],
        }),
      ).rejects.toThrow();

      // A member comments and mentions the manager.
      const row = await addComment(f.member, {
        experimentId: f.experiment.id,
        body: "Group B looks low — @Manager thoughts?",
        mentionIds: [f.manager.uid],
      });
      expect(row.author).toBe("Member");

      const notifications = await db.notification.findMany({
        where: { organizationId: f.organization.id },
        select: { userId: true, kind: true },
      });
      // Mentioned manager + experiment owner, nothing else.
      expect(notifications).toHaveLength(2);
      expect(notifications).toEqual(
        expect.arrayContaining([
          { userId: f.manager.uid, kind: "mentioned" },
          { userId: f.owner.uid, kind: "experiment_commented" },
        ]),
      );

      // The owner commenting their own experiment notifies nobody new.
      await addComment(f.owner, {
        experimentId: f.experiment.id,
        body: "Checked the logs, spin speed drifted.",
        mentionIds: [],
      });
      expect(
        await db.notification.count({
          where: { organizationId: f.organization.id },
        }),
      ).toBe(2);

      const thread = await listComments(f.member, f.experiment.id);
      expect(thread).toHaveLength(2);
      expect(
        await db.auditEvent.count({
          where: {
            organizationId: f.organization.id,
            action: "experiment.commented",
          },
        }),
      ).toBe(2);
    } finally {
      await removeOrganization(f.organization.id);
    }
  });

  it("drops cross-org mention ids instead of notifying them", async () => {
    const f = await fixture();
    const foreignSuffix = crypto.randomUUID();
    const foreignOrg = await db.organization.create({
      data: { name: "Foreign", slug: `comments-foreign-${foreignSuffix}` },
    });
    const foreignUser = await db.user.create({
      data: {
        organizationId: foreignOrg.id,
        email: `foreign-${foreignSuffix}@example.test`,
        name: "Foreign",
        passwordHash: "test-only",
        role: "ADMIN",
      },
    });
    try {
      await addComment(f.owner, {
        experimentId: f.experiment.id,
        body: "hello @Foreign",
        mentionIds: [foreignUser.id],
      });
      expect(
        await db.notification.count({ where: { userId: foreignUser.id } }),
      ).toBe(0);
    } finally {
      await removeOrganization(f.organization.id);
      await removeOrganization(foreignOrg.id);
    }
  });

  it("lets authors delete their own and managers moderate, but not others", async () => {
    const f = await fixture();
    try {
      const row = await addComment(f.member, {
        experimentId: f.experiment.id,
        body: "to be removed",
        mentionIds: [],
      });
      // A fellow member (no manage rights) cannot delete someone else's
      // comment; the author can. (The experiment's creator holds "manage"
      // and could moderate, like the manager below.)
      await expect(deleteComment(f.member2, row.id)).rejects.toThrow();
      await deleteComment(f.member, row.id);

      const again = await addComment(f.member, {
        experimentId: f.experiment.id,
        body: "moderate me",
        mentionIds: [],
      });
      await deleteComment(f.manager, again.id);
      expect(
        await db.experimentComment.count({
          where: { experimentId: f.experiment.id },
        }),
      ).toBe(0);
    } finally {
      await removeOrganization(f.organization.id);
    }
  });
});
