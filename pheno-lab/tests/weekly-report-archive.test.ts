import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { expect, it, vi } from "vitest";
import { restoreBaseline } from "../scripts/weekly-runner/archive";

const hash = (input: Uint8Array) =>
  createHash("sha256").update(input).digest("hex");

function archive() {
  const snapshot = Buffer.from('{"study":"synthetic"}'),
    ledger = Buffer.from('{"entries":[]}'),
    html = Buffer.from("<p>Test only</p>");
  const receipt = {
    reportId: randomUUID(),
    publicationKey: "materials-process-weekly-2099-01-01-v1",
    contentSha256: hash(html),
  };
  const record = Buffer.from(
    JSON.stringify({
      ...receipt,
      schemaVersion: 2,
      publicationVerified: true,
      snapshotSha256: hash(snapshot),
      dossierPublishedSha256: hash(ledger),
    }),
  );
  const contents = new Map([
    ["run-result.json", record],
    ["snapshot.json", snapshot],
    ["rd-dossier-published.json", ledger],
    ["report-publish.html", html],
  ]);
  const objects = new Map<string, Buffer>();
  const files = [...contents].map(([name, data]) => {
    const gz = gzipSync(data),
      key = hash(gz);
    objects.set(key, gz);
    return {
      name,
      sha256: hash(data),
      compressed: key,
      bytes: data.byteLength,
    };
  });
  return {
    receipt,
    manifest: {
      version: 1,
      reportId: receipt.reportId,
      publicationKey: receipt.publicationKey,
      files,
    },
    contents,
    get: async (k: string) => objects.get(k) ?? null,
  };
}

it("keeps an interrupted private restore invisible and verifies an identical completed retry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pheno-archive-")),
    target = join(dir, "week");
  const a = archive();
  try {
    let calls = 0;
    await expect(
      restoreBaseline(target, a.manifest, a.receipt, async (k) => {
        if (++calls === 3) throw Error("Synthetic COS interruption");
        return a.get(k);
      }),
    ).rejects.toThrow("interruption");
    expect(await readdir(dir)).toEqual([]);
    await Promise.all([
      restoreBaseline(target, a.manifest, a.receipt, a.get),
      restoreBaseline(target, a.manifest, a.receipt, a.get),
    ]);
    expect((await lstat(target)).mode & 0o077).toBe(0);
    for (const [name, bytes] of a.contents) {
      expect(await readFile(join(target, name))).toEqual(bytes);
      expect((await lstat(join(target, name))).mode & 0o077).toBe(0);
    }
    const noDownload = vi.fn(async () => null);
    await restoreBaseline(target, a.manifest, a.receipt, noDownload);
    expect(noDownload).not.toHaveBeenCalled();
    await writeFile(join(target, "report-publish.html"), "Unrelated contents");
    await expect(
      restoreBaseline(target, a.manifest, a.receipt, noDownload),
    ).rejects.toThrow("differ");
    expect(await readFile(join(target, "report-publish.html"), "utf8")).toBe(
      "Unrelated contents",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
