/**
 * Parse the archived instrument CSVs into J-V measurements.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/parse-archive-jv.ts --sample 40
 *   node node_modules/tsx/dist/cli.mjs scripts/parse-archive-jv.ts --apply [--limit N]
 *
 * The 2026-08 import attached every raw J-V file to its sample's result as a
 * text/csv Attachment under organizations/<org>/archive/… and stopped there:
 * the curves inside were never parsed, so the lab's history had summary
 * numbers but no (x, y) points. This reads each file back from object
 * storage, runs the same parsers the instrument bridge uses, and stores the
 * scans exactly as a live upload would — one InstrumentUpload per file
 * (sourcePath "archive:<attachmentId>" makes a rerun skip it), one
 * JvMeasurement per scan, linked to the sample the file was attached to.
 *
 * --sample parses N random files and reports detection/scan/point rates
 * without writing. --apply writes, in order, resumable, and bumps the
 * organization's data-point counter as it goes.
 */
import crypto from "node:crypto";
import path from "node:path";
import type { Prisma } from "@prisma/client";
import { db } from "../src/infrastructure/db/client";
import { objectStorage } from "../src/infrastructure/storage";
import {
  parseInstrumentFile,
  UnsupportedInstrumentFile,
} from "../src/lib/instruments";
import { scanKeyOf } from "../src/lib/instruments/scan-key";
import { normalizeSerial } from "../src/lib/instruments/normalize";
import { curveDataPoints } from "../src/lib/instruments/points";
import { recordSystemAudit } from "../src/modules/audit/writer";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : undefined;
};

type Att = {
  id: string;
  fileName: string;
  storedPath: string;
  createdAt: Date;
  characterizationResult: {
    sampleId: string | null;
    characterization: {
      experimentId: string;
      experiment: { organizationId: string };
    };
  } | null;
};

async function main() {
  const sample = value("--sample");
  const apply = flag("--apply");
  const limit = value("--limit");
  if (!sample && !apply) throw new Error("use --sample N or --apply");

  const instruments = await db.instrument.findMany({
    select: { id: true, kind: true, organizationId: true },
  });
  const instrumentFor = (org: string, kind: string) =>
    instruments.find((i) => i.organizationId === org && i.kind === kind)?.id ??
    null;

  const where: Prisma.AttachmentWhereInput = {
    mime: "text/csv",
    storedPath: { contains: "/archive/" },
    characterizationResultId: { not: null },
  };
  const total = await db.attachment.count({ where });
  console.log(`archive csv attachments: ${total}`);

  const stats = {
    files: 0,
    skipped: 0,
    unsupported: 0,
    empty: 0,
    failed: 0,
    scans: 0,
    points: 0,
    duplicates: 0,
    byKind: {} as Record<string, number>,
  };
  const storage = objectStorage();

  const process1 = async (att: Att) => {
    stats.files += 1;
    const link = att.characterizationResult;
    const org = link?.characterization.experiment.organizationId;
    if (!org) {
      stats.skipped += 1;
      return;
    }
    if (apply) {
      const seen = await db.instrumentUpload.findFirst({
        where: { sourcePath: `archive:${att.id}` },
        select: { id: true },
      });
      if (seen) {
        stats.skipped += 1;
        return;
      }
    }
    const bytes = await storage.get(att.storedPath);
    if (!bytes || bytes.length === 0) {
      stats.empty += 1;
      return;
    }
    const buf = Buffer.from(bytes);
    let parsed;
    try {
      parsed = parseInstrumentFile(buf, {
        fileName: att.fileName,
        sourceDir: path.posix.dirname(att.storedPath),
        fileModifiedAt: att.createdAt,
      });
    } catch (error) {
      if (error instanceof UnsupportedInstrumentFile) stats.unsupported += 1;
      else {
        stats.failed += 1;
        console.error(att.fileName, (error as Error).message);
      }
      return;
    }
    stats.byKind[parsed.instrument] =
      (stats.byKind[parsed.instrument] ?? 0) + 1;
    const points = parsed.scans.reduce(
      (n, s) => n + curveDataPoints(s.curve),
      0,
    );
    stats.scans += parsed.scans.length;
    stats.points += points;
    if (!apply) return;

    const instrumentId = instrumentFor(org, parsed.instrument);
    if (!instrumentId) {
      stats.failed += 1;
      console.error("no instrument for", parsed.instrument);
      return;
    }
    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    // The import attached one file to several samples: identical content is
    // stored once, later attachments of it are skipped.
    const sameContent = await db.instrumentUpload.findUnique({
      where: { instrumentId_sha256: { instrumentId, sha256 } },
      select: { id: true },
    });
    if (sameContent) {
      stats.duplicates += 1;
      return;
    }
    const experimentId = link!.characterization.experimentId;
    // A LIGHTSKY file carries dozens of scans for many samples: link each
    // scan to the sample whose code its serial matches inside this
    // experiment ("2018-8-Rev" on the rig, "2018" on the sheet: longest
    // prefix wins), else leave it at experiment level.
    const samples = await samplesOf(experimentId);
    const sampleFor = (serial: string): string | null => {
      const key = normalizeSerial(serial);
      const exact = samples.find((smp) => smp.key === key);
      if (exact) return exact.id;
      const byPrefix = samples
        .filter((smp) => smp.key.length >= 2 && key.startsWith(smp.key))
        .sort((a, b) => b.key.length - a.key.length)[0];
      return byPrefix?.id ?? null;
    };

    await db.$transaction(async (tx) => {
      const upload = await tx.instrumentUpload.create({
        data: {
          instrumentId,
          fileName: att.fileName,
          sourcePath: `archive:${att.id}`,
          storedPath: att.storedPath,
          sha256,
          size: buf.length,
          mime: "text/csv",
          modifiedAt: att.createdAt,
          status: "PARSED",
          message: ["archive", ...parsed.warnings].join(" "),
        },
      });
      let stored = 0;
      let storedPoints = 0;
      for (const scan of parsed.scans) {
        const scanKey = scanKeyOf(scan);
        const exists = await tx.jvMeasurement.findUnique({
          where: { instrumentId_scanKey: { instrumentId, scanKey } },
          select: { id: true },
        });
        if (exists) {
          stats.duplicates += 1;
          continue;
        }
        await tx.jvMeasurement.create({
          data: {
            organizationId: org,
            instrumentId,
            uploadId: upload.id,
            serial: scan.serial,
            serialKey: normalizeSerial(scan.serial),
            scanKey,
            direction: scan.direction,
            condition: scan.condition,
            measuredAt: scan.measuredAt,
            operator: scan.operator,
            material: scan.material,
            metrics: scan.metrics as Prisma.InputJsonValue,
            curve: scan.curve as Prisma.InputJsonValue,
            settings: scan.settings as Prisma.InputJsonValue,
            experimentId,
            sampleId: sampleFor(scan.serial),
            status: "MATCHED",
            matchNote:
              "archive: experiment from the attached result; sample by serial",
          },
        });
        stored += 1;
        storedPoints += curveDataPoints(scan.curve);
      }
      if (storedPoints > 0)
        await tx.organization.update({
          where: { id: org },
          data: { dataPoints: { increment: storedPoints } },
        });
      await recordSystemAudit(tx, {
        organizationId: org,
        action: "instrument.archive.parse",
        entityType: "InstrumentUpload",
        entityId: upload.id,
        metadata: { attachmentId: att.id, scans: stored, points: storedPoints },
      });
    });
  };

  const sampleCache = new Map<string, { id: string; key: string }[]>();
  const samplesOf = async (experimentId: string) => {
    const hit = sampleCache.get(experimentId);
    if (hit) return hit;
    const rows = await db.sample.findMany({
      where: { experimentId },
      select: { id: true, code: true },
    });
    const list = rows.map((r) => ({ id: r.id, key: normalizeSerial(r.code) }));
    sampleCache.set(experimentId, list);
    return list;
  };

  const select = {
    id: true,
    fileName: true,
    storedPath: true,
    createdAt: true,
    characterizationResult: {
      select: {
        sampleId: true,
        characterization: {
          select: {
            experimentId: true,
            experiment: { select: { organizationId: true } },
          },
        },
      },
    },
  } as const;

  if (sample) {
    // Random probe: every Nth id over a shuffled slice is close enough.
    const ids = await db.attachment.findMany({ where, select: { id: true } });
    const picked = ids.sort(() => Math.random() - 0.5).slice(0, sample);
    for (const { id } of picked) {
      const att = await db.attachment.findUniqueOrThrow({
        where: { id },
        select,
      });
      await process1(att as Att);
    }
  } else {
    let cursor: string | undefined;
    let done = 0;
    for (;;) {
      const batch = await db.attachment.findMany({
        where,
        select,
        orderBy: { id: "asc" },
        take: 200,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      if (batch.length === 0) break;
      for (const att of batch) {
        await process1(att as Att);
        done += 1;
        if (limit && done >= limit) break;
      }
      cursor = batch[batch.length - 1].id;
      console.log(
        `… ${done}/${total} files, ${stats.scans} scans, ${stats.points} points, skipped ${stats.skipped}`,
      );
      if (limit && done >= limit) break;
    }
  }
  console.log(JSON.stringify(stats));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
