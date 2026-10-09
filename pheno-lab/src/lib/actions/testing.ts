"use server";

import { revalidatePath } from "next/cache";
import { requireSession, assertPersonalDevice } from "@/lib/auth";
import { requestTesting } from "@/modules/testing/service";
import { revealAccountHandoff } from "@/modules/accounts/provisioning-service";

export async function notifyTesting(input: unknown) {
  const result = await requestTesting(await requireSession(), input);
  revalidatePath("/testing");
  return result;
}

export async function revealTemporaryLogin(id: string) {
  const session = await requireSession();
  assertPersonalDevice(session);
  return revealAccountHandoff(session, id);
}
