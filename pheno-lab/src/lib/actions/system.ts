"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth";
import { runDatabaseBackup } from "@/modules/system/service";

export async function backupNow(): Promise<{ ok: boolean; message: string }> {
  const result = await runDatabaseBackup(await requireSession());
  if (result.ok) {
    revalidatePath("/system");
  }
  return result;
}
