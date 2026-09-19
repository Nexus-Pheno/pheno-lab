/**
 * Feed a folder of instrument files through the live ingest path.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/ingest-raw-files.ts <dir> <orgSlug> [--limit N]
 *
 * <dir> holds files named <sha256>.<ext> under two-letter shards plus a
 * manifest.json of {sha256, name, rel, mtime} (see the local packer). Every
 * file goes through ingestInstrumentUpload exactly as a bridge upload would:
 * sha256 de-duplication per instrument (so what the archive parse already
 * stored is skipped), parsing, serial matching, storage, audit, and the
 * data-point counter. Nothing here bypasses the live rules.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { db } from "../src/infrastructure/db/client";
import { detectInstrument } from "../src/lib/instruments";
import { decodeLabText, parseCsvGrid } from "../src/lib/instruments/csv";
import { ingestInstrumentUpload } from "../src/modules/instruments/ingest-service";

type Entry = { sha256: string; name: string; rel: string; mtime: number };

async function main() {
  const [dir, slug, ...rest] = process.argv.slice(2);
  if (!dir || !slug)
    throw new Error("usage: ingest-raw-files.ts <dir> <orgSlug> [--limit N]");
  const li = rest.indexOf("--limit");
  const limit = li >= 0 ? Number(rest[li + 1]) : undefined;
  const org = await db.organization.findUniqueOrThrow({
    where: { slug },
    select: { id: true },
  });
  const instruments = await db.instrument.findMany({
    where: { organizationId: org.id },
    select: { id: true, organizationId: true, name: true, kind: true },
  });
  const manifest = JSON.parse(
    readFileSync(path.join(dir, "manifest.json"), "utf8"),
  ) as Entry[];
  const tally: Record<string, number> = {};
  let scans = 0;
  let done = 0;
  for (const entry of manifest) {
    if (limit && done >= limit) break;
    done += 1;
    const ext = path.extname(entry.name).toLowerCase();
    const body = readFileSync(
      path.join(dir, entry.sha256.slice(0, 2), `${entry.sha256}${ext}`),
    );
    const kind = detectInstrument(parseCsvGrid(decodeLabText(body)));
    const instrument = instruments.find((i) => i.kind === kind);
    if (!instrument) {
      tally.unrecognised = (tally.unrecognised ?? 0) + 1;
      continue;
    }
    const result = await ingestInstrumentUpload(instrument, {
      body,
      fileName: entry.name,
      sourcePath: `archive-raw:${entry.rel}`,
      sourceDir: path.posix.dirname(entry.rel),
      modifiedAt: new Date(entry.mtime * 1000),
      mime: ext === ".txt" ? "text/plain" : "text/csv",
    });
    tally[result.body.status] = (tally[result.body.status] ?? 0) + 1;
    scans += result.body.scans;
    if (done % 250 === 0)
      console.log(
        `… ${done}/${manifest.length}`,
        JSON.stringify(tally),
        `scans ${scans}`,
      );
  }
  console.log("DONE", JSON.stringify({ files: done, ...tally, scans }));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
