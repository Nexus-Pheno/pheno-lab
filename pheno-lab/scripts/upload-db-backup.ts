// Pushes a database dump to COS so backups survive the loss of the machine
// that hosts both the database and its local dumps (the gap found in the
// 2026-09-07 reliability audit; Michael approved R1).
//
// Called by the server's nightly backup cron AFTER pg_dump succeeds:
//   cd /srv/pheno-lab/current/pheno-lab
//   NODE_OPTIONS=--conditions=react-server \
//     /usr/bin/node node_modules/tsx/dist/cli.mjs \
//     scripts/upload-db-backup.ts /var/backups/pheno-lab/<dump>
//
// Retention on COS: 60 days. The adapter has no list operation, so rotation
// deletes the key dated exactly 61 days ago — an occasional gap (missed
// night) leaves a stray object behind, which is harmless at ~10 MB each.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { createHash } from "node:crypto";
import { objectStorage } from "../src/infrastructure/storage";

const COS_PREFIX = "backups/db/";

function keyForDate(date: Date): string {
  return `${COS_PREFIX}pheno_lab_${date.toISOString().slice(0, 10)}.dump`;
}

async function main(): Promise<void> {
  const dumpPath = process.argv[2];
  if (!dumpPath) {
    console.error("usage: upload-db-backup.ts /path/to/dump");
    process.exit(2);
  }
  const body = readFileSync(dumpPath);
  if (body.length < 1024) {
    // A dump this small is a failed pg_dump, not a backup. Refuse to
    // overwrite a good COS copy with it.
    console.error(`refusing to upload suspiciously small dump (${body.length} bytes)`);
    process.exit(1);
  }
  const storage = objectStorage();
  const key = keyForDate(new Date());
  await storage.put({
    key,
    body: new Uint8Array(body),
    contentType: "application/octet-stream",
    sha256: createHash("sha256").update(body).digest("hex"),
  });
  console.log(`uploaded ${basename(dumpPath)} -> ${key} (${body.length} bytes)`);

  const expired = new Date(Date.now() - 61 * 24 * 3600 * 1000);
  try {
    await storage.delete(keyForDate(expired));
  } catch {
    // Nothing to rotate that day — fine.
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("backup upload failed:", error);
    process.exit(1);
  });
