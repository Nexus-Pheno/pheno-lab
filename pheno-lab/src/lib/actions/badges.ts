"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { createSession, getDevice, requireSession } from "@/lib/auth";
import {
  bindBadge as bindBadgeService,
  unbindBadge as unbindBadgeService,
  authenticateBadge,
} from "@/modules/accounts/badge-service";

export async function bindBadge(
  uid: string,
  token: string,
): Promise<{ ok: boolean; error?: string }> {
  const session = await requireSession();
  try {
    await bindBadgeService(session, { uid, token });
    revalidatePath("/profile");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function unbindBadge(): Promise<void> {
  await unbindBadgeService(await requireSession());
  revalidatePath("/profile");
}

/**
 * Sign in with a tapped badge. Only registered shared tablets may call this —
 * without the device cookie the tap is refused, which is what makes a read or
 * cloned badge useless anywhere but on the lab's own tablets.
 */
export async function badgeLogin(
  uid: string,
  token: string,
): Promise<{ ok: boolean }> {
  const device = await getDevice();
  if (!device) return { ok: false };
  const result = await authenticateBadge(device.organizationId, {
    uid,
    token,
  }).catch(() => null);
  if (!result) return { ok: false };
  await createSession(result.actor);
  (await cookies()).set("pheno_lang", result.language, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  });
  return { ok: true };
}
