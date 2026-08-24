import "server-only";

import { db } from "@/infrastructure/db/client";
import type { Actor } from "@/modules/authorization/actor";

export const stewardshipKinds = [
  "materialAdmin",
  "equipmentAdmin",
  "facilityAdmin",
  "recipeAccess",
] as const;

export type Stewardship = (typeof stewardshipKinds)[number];

export async function assertStewardship(
  actor: Actor,
  kind: Stewardship,
): Promise<void> {
  if (actor.role === "ADMIN") return;
  const user = await db.user.findFirst({
    where: { id: actor.uid, organizationId: actor.org, active: true },
    select: { [kind]: true },
  });
  if (!user?.[kind]) {
    throw new Error(
      "You are not the responsible person for this part of the library.",
    );
  }
}

export async function hasStewardship(
  actor: Actor,
  kind: Stewardship,
): Promise<boolean> {
  try {
    await assertStewardship(actor, kind);
    return true;
  } catch {
    return false;
  }
}

export async function getStewardships(
  actor: Actor,
): Promise<Record<Stewardship, boolean>> {
  if (actor.role === "ADMIN") {
    return {
      materialAdmin: true,
      equipmentAdmin: true,
      facilityAdmin: true,
      recipeAccess: true,
    };
  }
  return db.user.findFirstOrThrow({
    where: { id: actor.uid, organizationId: actor.org, active: true },
    select: {
      materialAdmin: true,
      equipmentAdmin: true,
      facilityAdmin: true,
      recipeAccess: true,
    },
  });
}
