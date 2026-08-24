import "server-only";

import { readdir, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { serverConfig } from "@/infrastructure/config/server";
import { db } from "@/infrastructure/db/client";
import type { Actor } from "@/modules/authorization/actor";
import { assertAdmin } from "@/modules/authorization/policy";

async function directorySize(directory: string): Promise<number> {
  try {
    const entries = await readdir(directory);
    let total = 0;
    for (const entry of entries) {
      const item = await stat(path.join(directory, entry)).catch(() => null);
      if (item?.isFile()) total += item.size;
      else if (item?.isDirectory()) {
        total += await directorySize(path.join(directory, entry));
      }
    }
    return total;
  } catch {
    return 0;
  }
}

export async function getSystemStatus(actor: Actor) {
  assertAdmin(actor);
  const config = serverConfig();
  const databaseUrl = new URL(config.DATABASE_URL);
  const dbHost = databaseUrl.hostname || "localhost";
  const dbPort = databaseUrl.port || "5432";
  const dbName = databaseUrl.pathname.replace("/", "");
  const isLocal = dbHost === "localhost" || dbHost === "127.0.0.1";
  const [[sizeRow], tables] = await Promise.all([
    db.$queryRaw<{ size: bigint }[]>`
      SELECT pg_database_size(current_database()) AS size
    `,
    db.$queryRaw<{ name: string; size: bigint }[]>`
      SELECT relname AS name, pg_total_relation_size(relid) AS size
      FROM pg_catalog.pg_statio_user_tables
      ORDER BY pg_total_relation_size(relid) DESC
      LIMIT 8
    `,
  ]);
  const uploadsBytes = config.UPLOAD_DIR
    ? await directorySize(config.UPLOAD_DIR)
    : 0;

  let diskFreeBytes: number | null = null;
  let diskTotalBytes: number | null = null;
  try {
    const disk = await statfs(config.UPLOAD_DIR ?? process.cwd());
    diskTotalBytes = disk.blocks * disk.bsize;
    diskFreeBytes = disk.bavail * disk.bsize;
  } catch {
    // An unavailable filesystem is represented explicitly for the UI.
  }

  let backups: { name: string; sizeBytes: number; date: string }[] = [];
  try {
    const files = (await readdir(config.BACKUP_DIR))
      .filter((file) => file.endsWith(".sql.gz"))
      .sort()
      .reverse();
    backups = await Promise.all(
      files.slice(0, 10).map(async (file) => {
        const metadata = await stat(path.join(config.BACKUP_DIR, file));
        return {
          name: file,
          sizeBytes: metadata.size,
          date: metadata.mtime.toISOString().replace("T", " ").slice(0, 16),
        };
      }),
    );
  } catch {
    // No backup directory means there are no backups yet.
  }

  return {
    database: {
      host: dbHost,
      port: dbPort,
      name: dbName,
      local: isLocal,
      sizeBytes: Number(sizeRow?.size ?? 0),
      tables: tables.map((table) => ({
        name: table.name,
        sizeBytes: Number(table.size),
      })),
    },
    storage: { uploadsBytes, diskFreeBytes, diskTotalBytes },
    backups,
  };
}
