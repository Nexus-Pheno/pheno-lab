import "server-only";

import { db } from "@/infrastructure/db/client";
import type { Actor } from "@/modules/authorization/actor";
import { assertPlatformAdmin } from "./service";
import { assertStewardship } from "@/modules/stewardship/service";

export async function getOrganizationName(actor: Actor): Promise<string> {
  const row = await db.organization.findUnique({
    where: { id: actor.org },
    select: { name: true },
  });
  return row?.name ?? "";
}

export async function getOrganizationManagementData(actor: Actor) {
  await assertStewardship(actor, "memberAdmin");
  const [organization, users, pending] = await Promise.all([
    db.organization.findUniqueOrThrow({
      where: { id: actor.org },
      select: { name: true, orgNumber: true, emailDomains: true },
    }),
    actor.role === "ADMIN"
      ? db.user.findMany({
          // Registrations awaiting approval live in their own section, not here.
          where: { organizationId: actor.org, pendingApproval: false },
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
            recipeSteward: true,
            deviceAdmin: true,
            memberAdmin: true,
            projectId: true,
          },
        })
      : Promise.resolve([]),
    actor.role === "ADMIN"
      ? db.otpCode.findMany({
          where: {
            organizationId: actor.org,
            usedAt: null,
            expiresAt: { gt: new Date() },
          },
          orderBy: { createdAt: "desc" },
        })
      : Promise.resolve([]),
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
