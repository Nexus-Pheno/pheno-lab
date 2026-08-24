import "server-only";

import { db } from "@/infrastructure/db/client";
import type { Actor } from "@/modules/authorization/actor";
import { assertAdmin } from "@/modules/authorization/policy";
import { assertPlatformAdmin } from "./service";

export async function getOrganizationName(actor: Actor): Promise<string> {
  const row = await db.organization.findUnique({
    where: { id: actor.org },
    select: { name: true },
  });
  return row?.name ?? "";
}

export async function getOrganizationAdminData(actor: Actor) {
  assertAdmin(actor);
  const [organization, users, pending] = await Promise.all([
    db.organization.findUniqueOrThrow({ where: { id: actor.org } }),
    db.user.findMany({
      where: { organizationId: actor.org },
      orderBy: [{ role: "asc" }, { userNumber: "asc" }],
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        active: true,
        createdAt: true,
        materialAdmin: true,
        equipmentAdmin: true,
        facilityAdmin: true,
        recipeAccess: true,
      },
    }),
    db.otpCode.findMany({
      where: {
        organizationId: actor.org,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  return { organization, users, pending };
}

export async function listOrganizations(actor: Actor) {
  await assertPlatformAdmin(actor);
  return db.organization.findMany({
    orderBy: { orgNumber: "asc" },
    include: {
      users: {
        orderBy: { userNumber: "asc" },
        select: { name: true, email: true, role: true, active: true },
      },
    },
  });
}
