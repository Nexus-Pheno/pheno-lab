import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/infrastructure/db/client";
import { objectStorage } from "@/infrastructure/storage";
import type { Actor, ActorRole } from "@/modules/authorization/actor";
import { canReadObject } from "@/modules/files/authorization";
import {
  addComment,
  listComments,
} from "@/modules/experiments/comment-service";
import {
  addExperimentImages,
  deleteExperimentImage,
} from "@/modules/experiments/image-service";

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
    data: { name: "Images Org", slug: `img-${suffix}` },
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
  const outsider = await person("Outsider", "TECHNICIAN");
  const experiment = await db.experiment.create({
    data: {
      organizationId: organization.id,
      code: `IMG-${suffix.slice(0, 8)}`,
      title: "Picture this",
      createdById: owner.uid,
      members: { create: [{ userId: member.uid }] },
    },
  });
  const keyFor = (actor: Actor) =>
    `organizations/${organization.id}/users/${actor.uid}/images/2026/09/${crypto.randomUUID()}.png`;
  const put = async (key: string) => {
    await objectStorage().put({
      key,
      body: new Uint8Array([137, 80, 78, 71]),
      contentType: "image/png",
    });
    return key;
  };
  return { organization, owner, member, outsider, experiment, keyFor, put };
}

describe("experiment images against PostgreSQL", () => {
  it("attaches science-field images with the edit pen and org-scoped reads", async () => {
    const f = await fixture();
    const key = await f.put(f.keyFor(f.owner));
    try {
      // Members collaborate but do not edit the plan — or its images.
      await expect(
        addExperimentImages(f.member, {
          experimentId: f.experiment.id,
          context: "observation",
          fileNames: [key],
        }),
      ).rejects.toThrow();
      // A key outside the actor's own upload space is refused.
      await expect(
        addExperimentImages(f.owner, {
          experimentId: f.experiment.id,
          context: "observation",
          fileNames: [f.keyFor(f.outsider)],
        }),
      ).rejects.toThrow(/belong/i);

      const rows = await addExperimentImages(f.owner, {
        experimentId: f.experiment.id,
        context: "observation",
        fileNames: [key],
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].context).toBe("observation");

      // Members read via the experiment; outsiders do not.
      expect(await canReadObject(f.member, key)).toBe(true);
      expect(await canReadObject(f.outsider, key)).toBe(false);

      await deleteExperimentImage(f.owner, rows[0].id);
      expect(
        await db.attachment.count({
          where: { experimentId: f.experiment.id },
        }),
      ).toBe(0);
    } finally {
      await objectStorage()
        .delete(key)
        .catch(() => {});
      await removeOrganization(f.organization.id);
    }
  });

  it("carries photos on discussion comments", async () => {
    const f = await fixture();
    const key = await f.put(f.keyFor(f.member));
    try {
      const row = await addComment(f.member, {
        experimentId: f.experiment.id,
        body: "IV curve attached",
        mentionIds: [],
        photoFileNames: [key],
      });
      expect(row.photos).toHaveLength(1);
      expect(row.photos[0].path).toBe(key);

      const thread = await listComments(f.owner, f.experiment.id);
      expect(thread[0].photos.map((p) => p.path)).toContain(key);

      // The comment photo reads through the experiment for the owner…
      expect(await canReadObject(f.owner, key)).toBe(true);
      // …and stays closed to outsiders.
      expect(await canReadObject(f.outsider, key)).toBe(false);
    } finally {
      await objectStorage()
        .delete(key)
        .catch(() => {});
      await removeOrganization(f.organization.id);
    }
  });
});
