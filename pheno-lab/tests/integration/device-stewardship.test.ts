import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/infrastructure/db/client";
import type { Actor, ActorRole } from "@/modules/authorization/actor";
import {
  createDevice,
  listDevices,
  revokeDevice,
} from "@/modules/accounts/device-service";
import { setUserStewardship } from "@/modules/library/service";

afterAll(async () => {
  await db.$disconnect();
});

async function removeOrganization(organizationId: string): Promise<void> {
  await db.auditEvent.deleteMany({ where: { organizationId } });
  await db.sharedDevice.deleteMany({ where: { organizationId } });
  await db.user.deleteMany({ where: { organizationId } });
  await db.organization.delete({ where: { id: organizationId } });
}

async function fixture() {
  const suffix = crypto.randomUUID();
  const organization = await db.organization.create({
    data: { name: "Tablets", slug: `tab-${suffix}` },
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
  };
}

describe("shared-tablet stewardship against PostgreSQL", () => {
  it("opens the tablet console to a manager only once the admin hands it over", async () => {
    const f = await fixture();
    try {
      await expect(listDevices(f.manager)).rejects.toThrow(/responsible/i);
      await expect(createDevice(f.manager)).rejects.toThrow(/responsible/i);

      await setUserStewardship(f.admin, f.manager.uid, "deviceAdmin", true);

      const device = await createDevice(f.manager);
      expect((await listDevices(f.manager)).map((d) => d.id)).toContain(
        device.id,
      );
      await revokeDevice(f.manager, device.id);
      const row = await db.sharedDevice.findUniqueOrThrow({
        where: { id: device.id },
        select: { revokedAt: true },
      });
      expect(row.revokedAt).not.toBeNull();

      // Taking it back closes the door again.
      await setUserStewardship(f.admin, f.manager.uid, "deviceAdmin", false);
      await expect(listDevices(f.manager)).rejects.toThrow(/responsible/i);
      // Stewardship is the admin's to give, not the manager's to take.
      await expect(
        setUserStewardship(f.manager, f.manager.uid, "deviceAdmin", true),
      ).rejects.toThrow();
    } finally {
      await removeOrganization(f.organization.id);
    }
  });
});
