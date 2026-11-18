"use server";
import { requireAdmin, assertPersonalDevice } from "@/lib/auth";
import {
  issueReaderKey,
  revokeReaderKey,
} from "@/modules/research-reader/access";
import { revalidatePath } from "next/cache";
export async function issue(input: {
  label: string;
  days: number;
  reports: boolean;
  chemistry: boolean;
}) {
  const actor = await requireAdmin();
  assertPersonalDevice(actor);
  const key = await issueReaderKey(actor, input);
  revalidatePath("/profile/agent-access");
  return key.secret;
}
export async function revoke(id: string) {
  const actor = await requireAdmin();
  assertPersonalDevice(actor);
  await revokeReaderKey(actor, id);
  revalidatePath("/profile/agent-access");
}
