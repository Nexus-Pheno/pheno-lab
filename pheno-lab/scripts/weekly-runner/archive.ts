/** Backup only a reconciled four-file baseline in the organization's private COS namespace. */
import { createHash } from "node:crypto";
import {
  readFile,
  lstat,
  open,
  readdir,
  rename,
  mkdtemp,
  rm,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import { z } from "zod";
import { objectStorage } from "../../src/infrastructure/storage";
import { serverConfig } from "../../src/infrastructure/config/server";

const files = [
  "run-result.json",
  "snapshot.json",
  "rd-dossier-published.json",
  "report-publish.html",
] as const;
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const keyPattern = z.string().regex(/^materials-process-[a-z0-9-]{1,96}$/);
const prior = z.object({
  schemaVersion: z.literal(2),
  publicationVerified: z.literal(true),
  publicationKey: keyPattern,
  reportId: z.string().uuid(),
  contentSha256: hex,
  snapshotSha256: hex,
  dossierPublishedSha256: hex,
});
const entry = z
  .object({
    name: z.enum(files),
    sha256: hex,
    compressed: hex,
    bytes: z
      .number()
      .int()
      .positive()
      .max(512 * 1024 * 1024),
  })
  .strict();
const manifest = z
  .object({
    version: z.literal(1),
    reportId: z.string().uuid(),
    publicationKey: keyPattern,
    files: z.array(entry).length(files.length),
  })
  .strict();

type Receipt = {
  reportId: string;
  publicationKey: string;
  contentSha256: string;
};
type ArchiveManifest = z.infer<typeof manifest>;
function match(record: z.infer<typeof prior>, receipt: Receipt) {
  if (
    record.reportId !== receipt.reportId ||
    record.publicationKey !== receipt.publicationKey ||
    record.contentSha256 !== receipt.contentSha256
  )
    throw Error("Archived report identity differs");
}
async function syncDirectory(path: string) {
  const folder = await open(path, "r");
  try {
    await folder.sync();
  } finally {
    await folder.close();
  }
}
async function verifyRestored(
  dir: string,
  doc: ArchiveManifest,
  receipt: Receipt,
) {
  const directoryInfo = await lstat(dir);
  if (
    !directoryInfo.isDirectory() ||
    directoryInfo.mode & 0o077 ||
    directoryInfo.uid !== process.getuid?.()
  )
    throw Error("Restore requires an owner-private directory");
  const names = await readdir(dir);
  if (
    names.length !== files.length ||
    !files.every((name) => names.includes(name))
  )
    throw Error("Existing baseline restore directory differs");
  for (const entry of doc.files) {
    const path = join(dir, entry.name),
      info = await lstat(path);
    if (
      !info.isFile() ||
      info.uid !== directoryInfo.uid ||
      info.mode & 0o077 ||
      info.nlink !== 1 ||
      info.size !== entry.bytes ||
      digest(await readFile(path)) !== entry.sha256
    )
      throw Error("Stored baseline bytes differ");
  }
  const record = prior.parse(
    JSON.parse(await readFile(join(dir, files[0]), "utf8")),
  );
  match(record, receipt);
  if (
    doc.files[1].sha256 !== record.snapshotSha256 ||
    doc.files[2].sha256 !== record.dossierPublishedSha256 ||
    doc.files[3].sha256 !== record.contentSha256
  )
    throw Error("Archive manifest hashes differ from its report");
}
export async function restoreBaseline(
  directory: string,
  rawManifest: unknown,
  receipt: Receipt,
  get: (compressed: string) => Promise<Uint8Array | null>,
) {
  const doc = manifest.parse(rawManifest);
  if (
    doc.reportId !== receipt.reportId ||
    doc.publicationKey !== receipt.publicationKey ||
    !files.every((name, i) => name === doc.files[i].name)
  )
    throw Error("Archive identity or file list differs");
  const destination = resolve(directory),
    parent = dirname(destination);
  const present = await lstat(destination).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return false;
    },
  );
  if (present) {
    await verifyRestored(destination, doc, receipt);
    return;
  }
  const staging = await mkdtemp(
    join(parent, "." + basename(destination) + "-restore-"),
  );
  try {
    for (const entry of doc.files) {
      const zipped = await get(entry.compressed);
      if (!zipped || digest(zipped) !== entry.compressed)
        throw Error("Archive object is unavailable or changed");
      const bytes = gunzipSync(zipped, { maxOutputLength: entry.bytes });
      if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256)
        throw Error("Restored object differs");
      const handle = await open(join(staging, entry.name), "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    await verifyRestored(staging, doc, receipt);
    await syncDirectory(staging);
    try {
      await rename(staging, destination);
    } catch (error) {
      if (
        !["ENOTEMPTY", "EEXIST"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
      // A concurrent restore may have installed the identical complete directory.
      await verifyRestored(destination, doc, receipt);
    }
    await syncDirectory(parent);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
async function main() {
  process.umask(0o077);
  const [operation, directory, receiptFile] = process.argv.slice(2);
  if (
    !["save", "restore"].includes(operation) ||
    serverConfig().STORAGE_DRIVER !== "cos"
  )
    throw Error();
  const receipt = z
    .object({
      status: z.literal("PUBLISHED"),
      organizationId: z.string().regex(/^[a-zA-Z0-9-]+$/),
      publicationKey: keyPattern,
      reportId: z.string().uuid(),
      contentSha256: hex,
    })
    .parse(JSON.parse(await readFile(receiptFile, "utf8")));
  const storage = objectStorage();
  const prefix = `organizations/${receipt.organizationId}/private-weekly-baselines/${receipt.reportId}/`;
  const marker = prefix + "manifest-v1.json";
  async function storeVerified(key: string, data: Buffer, contentType: string) {
    const hash = digest(data);
    if (!(await storage.exists(key)))
      await storage.put({ key, body: data, sha256: hash, contentType });
    const confirmed = await storage.get(key);
    if (!confirmed || digest(confirmed) !== hash) throw Error();
  }
  if (operation === "save") {
    const original = prior.parse(
      JSON.parse(await readFile(join(directory, files[0]), "utf8")),
    );
    match(original, receipt);
    const expected = [
      undefined,
      original.snapshotSha256,
      original.dossierPublishedSha256,
      original.contentSha256,
    ];
    const entries = [];
    for (const [i, name] of files.entries()) {
      const path = join(directory, name);
      const info = await lstat(path);
      if (!info.isFile() || info.mode & 0o077 || info.size > 512 * 1024 * 1024)
        throw Error();
      const data = await readFile(path);
      const sha256 = digest(data);
      if (i && sha256 !== expected[i]) throw Error();
      const gz = gzipSync(data, { level: 3 });
      const compressed = digest(gz);
      await storeVerified(prefix + compressed + ".gz", gz, "application/gzip");
      entries.push({ name, sha256, compressed, bytes: data.length });
    }
    const doc = manifest.parse({
      version: 1,
      reportId: original.reportId,
      publicationKey: original.publicationKey,
      files: entries,
    });
    await storeVerified(
      marker,
      Buffer.from(JSON.stringify(doc)),
      "application/json",
    );
  } else {
    const data = await storage.get(marker);
    if (!data || data.byteLength > 8192) throw Error();
    await restoreBaseline(
      directory,
      JSON.parse(Buffer.from(data).toString()),
      receipt,
      (hash) => storage.get(prefix + hash + ".gz"),
    );
  }
  console.log(
    JSON.stringify({
      status: operation === "save" ? "BACKUP_VERIFIED" : "RESTORE_VERIFIED",
      fileCount: files.length,
    }),
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch(() => {
    console.error(
      "Weekly private baseline transfer or integrity verification failed.",
    );
    process.exitCode = 1;
  });
