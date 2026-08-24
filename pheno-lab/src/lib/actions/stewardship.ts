"use server";

import { db } from "@/lib/db";
import { requireSession, type Session } from "@/lib/auth";

// Stewardships: an organization assigns responsible people for materials,
// equipment and facilities. Admins always hold every stewardship.

export type Stewardship = "materialAdmin" | "equipmentAdmin" | "facilityAdmin" | "recipeAccess";

export async function assertSteward(kind: Stewardship): Promise<Session> {
  const session = await requireSession();
  if (session.role === "ADMIN") return session;
  const user = await db.user.findUniqueOrThrow({ where: { id: session.uid } });
  if (!user[kind]) throw new Error("You are not the responsible person for this part of the library.");
  return session;
}

export async function hasSteward(kind: Stewardship): Promise<boolean> {
  try {
    await assertSteward(kind);
    return true;
  } catch {
    return false;
  }
}

/** All four flags for the signed-in user, for gating UI in one round trip. */
export async function mySteward(): Promise<Record<Stewardship, boolean>> {
  const session = await requireSession();
  if (session.role === "ADMIN") {
    return { materialAdmin: true, equipmentAdmin: true, facilityAdmin: true, recipeAccess: true };
  }
  const u = await db.user.findUniqueOrThrow({ where: { id: session.uid } });
  return {
    materialAdmin: u.materialAdmin,
    equipmentAdmin: u.equipmentAdmin,
    facilityAdmin: u.facilityAdmin,
    recipeAccess: u.recipeAccess,
  };
}
