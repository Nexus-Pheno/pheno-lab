/** Backup only a reconciled four-file baseline in the organization's private COS namespace. */
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, lstat } from "node:fs/promises";
import { join } from "node:path";
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
  function match(record: z.infer<typeof prior>) {
    if (
      record.reportId !== receipt.reportId ||
      record.publicationKey !== receipt.publicationKey ||
      record.contentSha256 !== receipt.contentSha256
    )
      throw Error();
  }
  if (operation === "save") {
    const original = prior.parse(
      JSON.parse(await readFile(join(directory, files[0]), "utf8")),
    );
    match(original);
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
    const doc = manifest.parse(JSON.parse(Buffer.from(data).toString()));
    if (
      doc.reportId !== receipt.reportId ||
      doc.publicationKey !== receipt.publicationKey ||
      !files.every((name, i) => name === doc.files[i].name)
    )
      throw Error();
    await mkdir(directory, { mode: 0o700 });
    for (const item of doc.files) {
      const zipped = await storage.get(prefix + item.compressed + ".gz");
      if (!zipped || digest(zipped) !== item.compressed) throw Error();
      const plain = gunzipSync(zipped, { maxOutputLength: item.bytes });
      if (plain.length !== item.bytes || digest(plain) !== item.sha256)
        throw Error();
      await writeFile(join(directory, item.name), plain, {
        mode: 0o600,
        flag: "wx",
      });
    }
    const original = prior.parse(
      JSON.parse(await readFile(join(directory, files[0]), "utf8")),
    );
    match(original);
    if (
      doc.files[1].sha256 !== original.snapshotSha256 ||
      doc.files[2].sha256 !== original.dossierPublishedSha256 ||
      doc.files[3].sha256 !== original.contentSha256
    )
      throw Error();
  }
  console.log(
    JSON.stringify({
      status: operation === "save" ? "BACKUP_VERIFIED" : "RESTORE_VERIFIED",
      fileCount: files.length,
    }),
  );
}
main().catch(() => {
  console.error(
    "Weekly private baseline transfer or integrity verification failed.",
  );
  process.exitCode = 1;
});
