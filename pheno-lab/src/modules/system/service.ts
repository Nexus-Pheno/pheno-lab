import "server-only";

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { serverConfig } from "@/infrastructure/config/server";
import { db } from "@/infrastructure/db/client";
import type { Actor } from "@/modules/authorization/actor";
import { assertAdmin } from "@/modules/authorization/policy";
import { recordUserAudit } from "@/modules/audit/writer";

const run = promisify(execFile);

export async function runDatabaseBackup(
  actor: Actor,
): Promise<{ ok: boolean; message: string }> {
  assertAdmin(actor);
  const script = path.join(process.cwd(), "scripts", "backup.sh");
  try {
    await recordUserAudit(db, {
      actor,
      action: "system.database_backup.requested",
      entityType: "Database",
      entityId: actor.org,
    });
    const config = serverConfig();
    const { stdout } = await run("/bin/bash", [script], {
      timeout: 120_000,
      env: {
        ...process.env,
        DATABASE_URL: config.DATABASE_URL,
        BACKUP_DIR: config.BACKUP_DIR,
        ...(config.PG_DUMP_BIN ? { PG_DUMP_BIN: config.PG_DUMP_BIN } : {}),
      },
    });
    return { ok: true, message: stdout.trim() };
  } catch (error) {
    return { ok: false, message: String(error).slice(0, 300) };
  }
}
