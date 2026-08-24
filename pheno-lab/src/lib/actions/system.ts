"use server";

import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";

const run = promisify(exec);

export async function backupNow(): Promise<{ ok: boolean; message: string }> {
  await requireAdmin();
  const script = path.join(process.cwd(), "scripts", "backup.sh");
  try {
    const { stdout } = await run(`bash "${script}"`, { timeout: 120_000 });
    revalidatePath("/system");
    return { ok: true, message: stdout.trim() };
  } catch (e) {
    return { ok: false, message: String(e).slice(0, 300) };
  }
}
