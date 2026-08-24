import "server-only";

import crypto from "node:crypto";
import path from "node:path";
import { Prisma } from "@prisma/client";
import { db } from "@/infrastructure/db/client";
import { objectStorage } from "@/infrastructure/storage";
import type { AuthedInstrument } from "./authentication-service";
import {
  parseInstrumentFile,
  UnsupportedInstrumentFile,
} from "@/lib/instruments";
import {
  matchSerial,
  normalizeSerial,
  refreshSampleJvResult,
} from "./matching-service";
import { scanKeyOf } from "@/lib/instruments/scan-key";
import { recordInstrumentAudit } from "@/modules/audit/writer";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png"]);

export type InstrumentUploadInput = {
  body: Buffer;
  fileName: string;
  sourcePath: string;
  sourceDir: string;
  modifiedAt: Date | null;
  mime: string;
};

export type InstrumentIngestResult = {
  statusCode: number;
  body: {
    status: "stored" | "duplicate" | "unmatched" | "rejected";
    message: string;
    scans: number;
  };
};

const result = (
  statusCode: number,
  status: InstrumentIngestResult["body"]["status"],
  message: string,
  scans = 0,
): InstrumentIngestResult => ({
  statusCode,
  body: { status, message, scans },
});

function datedObjectPrefix(instrument: AuthedInstrument): string {
  const now = new Date();
  return path.posix.join(
    "organizations",
    instrument.organizationId,
    "instruments",
    instrument.id,
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
  );
}

export async function ingestInstrumentUpload(
  instrument: AuthedInstrument,
  input: InstrumentUploadInput,
): Promise<InstrumentIngestResult> {
  const sha256 = crypto.createHash("sha256").update(input.body).digest("hex");
  const rawExtension = path.extname(input.fileName).toLowerCase();
  const extension = /^\.[a-z0-9]{1,10}$/.test(rawExtension)
    ? rawExtension
    : ".csv";
  const baseName = path.basename(input.fileName, rawExtension);

  const seen = await db.instrumentUpload.findUnique({
    where: { instrumentId_sha256: { instrumentId: instrument.id, sha256 } },
    select: { id: true },
  });
  if (seen) return result(409, "duplicate", "Already received this file");

  const prefix = datedObjectPrefix(instrument);

  if (IMAGE_EXTENSIONS.has(extension)) {
    const storedPath = path.posix.join(
      prefix,
      "images",
      `${sha256}${extension === ".jpeg" ? ".jpg" : extension}`,
    );
    await objectStorage().put({
      key: storedPath,
      body: input.body,
      contentType: input.mime || "image/jpeg",
      sha256,
    });
    const linked = await db.$transaction(async (transaction) => {
      const upload = await transaction.instrumentUpload.create({
        data: {
          instrumentId: instrument.id,
          fileName: input.fileName,
          sourcePath: input.sourcePath,
          storedPath,
          sha256,
          size: input.body.length,
          mime: input.mime || "image/jpeg",
          modifiedAt: input.modifiedAt,
          status: "ATTACHMENT",
          message: "",
        },
      });
      const update = await transaction.jvMeasurement.updateMany({
        where: {
          instrumentId: instrument.id,
          imagePath: null,
          upload: { fileName: { startsWith: baseName } },
        },
        data: { imagePath: storedPath },
      });
      await recordInstrumentAudit(transaction, {
        organizationId: instrument.organizationId,
        instrumentId: instrument.id,
        action: "instrument.upload.attachment",
        entityType: "InstrumentUpload",
        entityId: upload.id,
        metadata: {
          sha256,
          size: input.body.length,
          linkedScans: update.count,
        },
      });
      return update.count;
    });
    return result(
      200,
      "stored",
      linked ? `Attached to ${linked} scan(s)` : "Stored; no matching scan yet",
    );
  }

  const storedPath = path.posix.join(prefix, `${sha256}${extension}`);
  await objectStorage().put({
    key: storedPath,
    body: input.body,
    contentType: input.mime || "text/csv",
    sha256,
  });

  const uploadBase = {
    instrumentId: instrument.id,
    fileName: input.fileName,
    sourcePath: input.sourcePath,
    storedPath,
    sha256,
    size: input.body.length,
    mime: input.mime || "text/csv",
    modifiedAt: input.modifiedAt,
  };

  let parsed: ReturnType<typeof parseInstrumentFile>;
  try {
    parsed = parseInstrumentFile(input.body, {
      fileName: input.fileName,
      sourceDir: input.sourceDir,
      fileModifiedAt: input.modifiedAt ?? undefined,
      instrument: instrument.kind,
    });
  } catch (error) {
    const message =
      error instanceof UnsupportedInstrumentFile
        ? error.message
        : `Could not read this file: ${(error as Error).message}`;
    await db.$transaction(async (transaction) => {
      const upload = await transaction.instrumentUpload.create({
        data: { ...uploadBase, status: "REJECTED", message },
      });
      await recordInstrumentAudit(transaction, {
        organizationId: instrument.organizationId,
        instrumentId: instrument.id,
        action: "instrument.upload.reject",
        entityType: "InstrumentUpload",
        entityId: upload.id,
        metadata: { sha256, size: input.body.length, reason: message },
      });
    });
    return result(422, "rejected", message);
  }

  const priorImage = await db.instrumentUpload.findFirst({
    where: {
      instrumentId: instrument.id,
      status: "ATTACHMENT",
      fileName: { startsWith: baseName },
    },
    orderBy: { receivedAt: "desc" },
    select: { storedPath: true },
  });

  const accepted: Array<{
    scan: (typeof parsed.scans)[number];
    scanKey: string;
    match: Awaited<ReturnType<typeof matchSerial>>;
  }> = [];
  let duplicateScans = 0;
  for (const scan of parsed.scans) {
    const scanKey = scanKeyOf(scan);
    const exists = await db.jvMeasurement.findUnique({
      where: { instrumentId_scanKey: { instrumentId: instrument.id, scanKey } },
      select: { id: true },
    });
    if (exists) {
      duplicateScans++;
      continue;
    }
    accepted.push({
      scan,
      scanKey,
      match: await matchSerial(instrument.organizationId, scan.serial),
    });
  }

  await db.$transaction(async (transaction) => {
    const upload = await transaction.instrumentUpload.create({
      data: {
        ...uploadBase,
        status: "PARSED",
        message: parsed.warnings.join(" "),
      },
    });
    for (const { scan, scanKey, match } of accepted) {
      await transaction.jvMeasurement.create({
        data: {
          organizationId: instrument.organizationId,
          instrumentId: instrument.id,
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
          imagePath: priorImage?.storedPath ?? null,
          experimentId: match.experimentId,
          sampleId: match.sampleId,
          runId: match.runId,
          status: match.status,
          matchNote: match.matchNote,
        },
      });
    }
    await recordInstrumentAudit(transaction, {
      organizationId: instrument.organizationId,
      instrumentId: instrument.id,
      action: "instrument.upload.parse",
      entityType: "InstrumentUpload",
      entityId: upload.id,
      metadata: {
        sha256,
        size: input.body.length,
        scans: accepted.length,
        duplicateScans,
      },
    });
  });

  const touchedSamples = new Set(
    accepted.flatMap(({ match }) => (match.sampleId ? [match.sampleId] : [])),
  );
  const notes = accepted.flatMap(({ match }) =>
    match.sampleId ? [] : [match.matchNote],
  );
  for (const sampleId of touchedSamples) {
    const outcome = await refreshSampleJvResult(sampleId);
    if (outcome === "no-card") {
      notes.push(
        "Matched, but the experiment has no J-V characterization card to fill.",
      );
    }
    if (outcome === "kept-manual") {
      notes.push("Matched; kept the value a technician had already typed in.");
    }
  }

  if (duplicateScans) {
    notes.push(
      `${duplicateScans} scan(s) were already recorded from an earlier file.`,
    );
  }
  const matched = touchedSamples.size;
  const newScans = accepted.length;
  return result(
    200,
    matched ? "stored" : newScans === 0 ? "duplicate" : "unmatched",
    [...parsed.warnings, ...new Set(notes)].join(" ").slice(0, 500),
    newScans,
  );
}
