"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSession, setDeviceCookie } from "@/lib/auth";
import {
  createDevice as createDeviceService,
  revokeDevice as revokeDeviceService,
  claimDevice as claimDeviceService,
  type SharedDeviceRow,
} from "@/modules/accounts/device-service";

export type { SharedDeviceRow };

export async function createDevice(): Promise<SharedDeviceRow> {
  const row = await createDeviceService(await requireSession());
  revalidatePath("/kiosk");
  return row;
}

export async function revokeDevice(id: string): Promise<void> {
  await revokeDeviceService(await requireSession(), id);
  revalidatePath("/kiosk");
}

/** Runs ON the tablet, sessionless: name it, consume the token, pin the cookie. */
export async function claimDevice(token: string, label: string): Promise<void> {
  const device = await claimDeviceService(token, label);
  if (!device) redirect("/login?claim=invalid");
  await setDeviceCookie(device.id);
  redirect("/login?claim=ok");
}
