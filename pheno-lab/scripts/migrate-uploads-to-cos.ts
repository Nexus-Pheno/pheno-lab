/**
 * One-time migration of legacy local uploads into the COS private bucket.
 *
 * Implements docs/architecture-refactor.md §10.5. The ordering is deliberate:
 * the source directory is only ever read, every object is verified by reading
 * it back before the database is repointed, and each row is repointed inside a
 * transaction that also writes its audit event. Nothing is deleted — cleaning
 * up the old directory stays a human decision made after production downloads
 * have been verified (§10.5 步骤 7–8).
 *
 * Legacy values are bare file names written when everything lived flat under
 * `uploads/`; keys created after the storage refactor are nested paths. That
 * difference is what makes this script idempotent: a row is a migration
 * candidate only while its value contains no `/`.
 *
 *   pnpm exec tsx scripts/migrate-uploads-to-cos.ts                 # dry run
 *   pnpm exec tsx scripts/migrate-uploads-to-cos.ts --apply
 *   pnpm exec tsx scripts/migrate-uploads-to-cos.ts --apply --limit 50
 *
 * Dry run needs nothing but the source directory; --apply needs the COS
 * settings from the deployment environment.
 */

import crypto from "node:crypto";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { CosObjectStorage } from "../src/infrastructure/storage/cos";
import {
  CvmRoleCosCredentialProvider,
  StaticCosCredentialProvider,
} from "../src/infrastructure/storage/cos-credentials";
import { LocalObjectStorage } from "../src/infrastructure/storage/local";
import { recordSystemAudit } from "../src/modules/audit/writer";
import type { ObjectStorage } from "../src/infrastructure/storage/types";

type Kind = "equipment" | "feedback" | "instrument" | "attachment";

type Candidate = {
  kind: Kind;
  rowId: string;
  organizationId: string;
  /** The bare legacy file name stored in the column. */
  legacyValue: string;
  /** Extra path segment: instrument id or run id, depending on kind. */
  group?: string;
  createdAt: Date;
};

type Outcome =
  | { status: "migrated"; candidate: Candidate; key: string; bytes: number }
  | { status: "planned"; candidate: Candidate; key: string; bytes: number }
  | { status: "reused"; candidate: Candidate; key: string; bytes: number }
  | { status: "missing"; candidate: Candidate }
  | { status: "failed"; candidate: Candidate; reason: string };

const MIME_BY_EXTENSION: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".pdf": "application/pdf",
};

const db = new PrismaClient();

function parseArguments(argv: string[]) {
  const apply = argv.includes("--apply");
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const rawLimit = value("--limit");
  const limit = rawLimit ? Number.parseInt(rawLimit, 10) : undefined;
  if (rawLimit && (!Number.isInteger(limit) || limit! < 1)) {
    throw new Error("--limit must be a positive integer");
  }
  return { apply, limit, source: value("--source") };
}

function resolveSourceDirectory(explicit?: string): string {
  const directory =
    explicit ??
    process.env.COS_LEGACY_UPLOAD_DIR ??
    process.env.UPLOAD_DIR ??
    undefined;
  if (!directory) {
    throw new Error(
      "No source directory. Pass --source, or set COS_LEGACY_UPLOAD_DIR / UPLOAD_DIR.",
    );
  }
  return path.resolve(directory);
}

function buildCosStorage(): ObjectStorage {
  const region = process.env.COS_REGION;
  const bucket = process.env.COS_FILES_BUCKET;
  const authMode = process.env.COS_AUTH_MODE;
  if (!region || !bucket || !authMode) {
    throw new Error(
      "--apply needs COS_REGION, COS_FILES_BUCKET and COS_AUTH_MODE.",
    );
  }
  if (authMode === "instance-role") {
    return new CosObjectStorage(
      region,
      bucket,
      new CvmRoleCosCredentialProvider(),
    );
  }
  const secretId = process.env.COS_SECRET_ID;
  const secretKey = process.env.COS_SECRET_KEY;
  if (!secretId || !secretKey) {
    throw new Error(
      "COS_AUTH_MODE=static needs COS_SECRET_ID and COS_SECRET_KEY.",
    );
  }
  return new CosObjectStorage(
    region,
    bucket,
    new StaticCosCredentialProvider({ secretId, secretKey }),
  );
}

/** A value that already contains a path separator was written post-refactor. */
function isLegacyValue(value: string): boolean {
  return value.length > 0 && !value.includes("/");
}

async function collectCandidates(): Promise<Candidate[]> {
  const candidates: Candidate[] = [];

  const equipment = await db.equipment.findMany({
    where: { photoPath: { not: "" } },
    select: {
      id: true,
      organizationId: true,
      photoPath: true,
      createdAt: true,
    },
  });
  for (const row of equipment) {
    if (!isLegacyValue(row.photoPath)) continue;
    candidates.push({
      kind: "equipment",
      rowId: row.id,
      organizationId: row.organizationId,
      legacyValue: row.photoPath,
      createdAt: row.createdAt,
    });
  }

  const feedback = await db.feedback.findMany({
    where: { screenshotPath: { not: "" } },
    select: {
      id: true,
      organizationId: true,
      screenshotPath: true,
      createdAt: true,
    },
  });
  for (const row of feedback) {
    if (!isLegacyValue(row.screenshotPath)) continue;
    candidates.push({
      kind: "feedback",
      rowId: row.id,
      organizationId: row.organizationId,
      legacyValue: row.screenshotPath,
      createdAt: row.createdAt,
    });
  }

  const uploads = await db.instrumentUpload.findMany({
    select: {
      id: true,
      storedPath: true,
      receivedAt: true,
      instrument: { select: { id: true, organizationId: true } },
    },
  });
  for (const row of uploads) {
    if (!isLegacyValue(row.storedPath)) continue;
    candidates.push({
      kind: "instrument",
      rowId: row.id,
      organizationId: row.instrument.organizationId,
      legacyValue: row.storedPath,
      group: row.instrument.id,
      createdAt: row.receivedAt,
    });
  }

  // Attachments reach an organization through either of their two optional
  // parents, so both paths are resolved here rather than in the key builder.
  const attachments = await db.attachment.findMany({
    select: {
      id: true,
      storedPath: true,
      createdAt: true,
      stepExecution: {
        select: {
          runId: true,
          run: { select: { experiment: { select: { organizationId: true } } } },
        },
      },
      characterizationResult: {
        select: {
          runId: true,
          characterization: {
            select: { experiment: { select: { organizationId: true } } },
          },
        },
      },
    },
  });
  for (const row of attachments) {
    if (!isLegacyValue(row.storedPath)) continue;
    const organizationId =
      row.stepExecution?.run.experiment.organizationId ??
      row.characterizationResult?.characterization.experiment.organizationId;
    if (!organizationId) {
      console.warn(
        `[skip] attachment ${row.id} has no parent experiment; leaving it in place`,
      );
      continue;
    }
    candidates.push({
      kind: "attachment",
      rowId: row.id,
      organizationId,
      legacyValue: row.storedPath,
      group:
        row.stepExecution?.runId ??
        row.characterizationResult?.runId ??
        "unlinked",
      createdAt: row.createdAt,
    });
  }

  return candidates;
}

/**
 * Content-addressed so a re-run lands on the same key and two rows sharing a
 * file share one object. Shape follows §10.3; no original file name, so no
 * personal data leaks into the key.
 */
function objectKeyFor(candidate: Candidate, sha256: string): string {
  const extension = path.extname(candidate.legacyValue).toLowerCase();
  const name = `${sha256}${extension}`;
  const year = String(candidate.createdAt.getUTCFullYear());
  const month = String(candidate.createdAt.getUTCMonth() + 1).padStart(2, "0");
  const prefix = ["organizations", candidate.organizationId];
  switch (candidate.kind) {
    case "equipment":
      return [...prefix, "images", year, month, name].join("/");
    case "feedback":
      return [...prefix, "feedback", year, month, name].join("/");
    case "instrument":
      return [
        ...prefix,
        "instruments",
        candidate.group!,
        year,
        month,
        name,
      ].join("/");
    case "attachment":
      return [...prefix, "executions", candidate.group!, name].join("/");
  }
}

function contentTypeFor(legacyValue: string): string {
  return (
    MIME_BY_EXTENSION[path.extname(legacyValue).toLowerCase()] ??
    "application/octet-stream"
  );
}

async function repoint(
  candidate: Candidate,
  key: string,
  sha256: string,
  bytes: number,
): Promise<void> {
  await db.$transaction(async (transaction) => {
    switch (candidate.kind) {
      case "equipment":
        await transaction.equipment.update({
          where: { id: candidate.rowId },
          data: { photoPath: key },
        });
        break;
      case "feedback":
        await transaction.feedback.update({
          where: { id: candidate.rowId },
          data: { screenshotPath: key },
        });
        break;
      case "instrument":
        await transaction.instrumentUpload.update({
          where: { id: candidate.rowId },
          data: { storedPath: key },
        });
        break;
      case "attachment":
        await transaction.attachment.update({
          where: { id: candidate.rowId },
          data: { storedPath: key },
        });
        break;
    }
    // Through the audit writer rather than a raw create so the payload passes
    // the §9.3 sanitiser like every other event.
    await recordSystemAudit(transaction, {
      organizationId: candidate.organizationId,
      action: "storage.migrated",
      entityType: candidate.kind,
      entityId: candidate.rowId,
      changes: { from: candidate.legacyValue, to: key },
      metadata: { sha256, bytes },
    });
  });
}

async function migrateOne(
  candidate: Candidate,
  source: ObjectStorage,
  destination: ObjectStorage | null,
): Promise<Outcome> {
  const body = await source.get(candidate.legacyValue);
  if (!body) return { status: "missing", candidate };

  const sha256 = crypto.createHash("sha256").update(body).digest("hex");
  const key = objectKeyFor(candidate, sha256);

  if (!destination) {
    return { status: "planned", candidate, key, bytes: body.byteLength };
  }

  try {
    // Content-addressed keys make a pre-existing object proof that the bytes
    // are already there — an interrupted run resumes instead of re-uploading.
    const alreadyThere = await destination.exists(key);
    if (!alreadyThere) {
      await destination.put({
        key,
        body,
        contentType: contentTypeFor(candidate.legacyValue),
        sha256,
      });
    }

    // §10.5 步骤 4: read back before the database is repointed. Full
    // verification rather than sampling — these are research records and the
    // volumes are small.
    const stored = await destination.get(key);
    if (!stored) throw new Error("object is not readable after upload");
    if (stored.byteLength !== body.byteLength) {
      throw new Error(
        `size mismatch: local ${body.byteLength}, remote ${stored.byteLength}`,
      );
    }
    const remoteHash = crypto.createHash("sha256").update(stored).digest("hex");
    if (remoteHash !== sha256) throw new Error("sha256 mismatch after upload");

    await repoint(candidate, key, sha256, body.byteLength);
    return {
      status: alreadyThere ? "reused" : "migrated",
      candidate,
      key,
      bytes: body.byteLength,
    };
  } catch (error) {
    return {
      status: "failed",
      candidate,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main(): Promise<void> {
  const {
    apply,
    limit,
    source: sourceFlag,
  } = parseArguments(process.argv.slice(2));
  const sourceDirectory = resolveSourceDirectory(sourceFlag);
  const source = new LocalObjectStorage(sourceDirectory);
  const destination = apply ? buildCosStorage() : null;

  console.log(`source      ${sourceDirectory}`);
  console.log(`destination ${apply ? "COS" : "(dry run — nothing written)"}`);

  const all = await collectCandidates();
  const candidates = limit ? all.slice(0, limit) : all;
  console.log(
    `candidates  ${candidates.length}${limit && all.length > limit ? ` of ${all.length} (--limit)` : ""}\n`,
  );

  const outcomes: Outcome[] = [];
  for (const candidate of candidates) {
    const outcome = await migrateOne(candidate, source, destination);
    outcomes.push(outcome);
    if (outcome.status === "missing") {
      console.warn(
        `[missing] ${candidate.kind} ${candidate.rowId} → ${candidate.legacyValue} not found on disk`,
      );
    } else if (outcome.status === "failed") {
      console.error(
        `[failed]  ${candidate.kind} ${candidate.rowId}: ${outcome.reason}`,
      );
    } else {
      console.log(
        `[${outcome.status}] ${candidate.kind} ${candidate.rowId} → ${outcome.key}`,
      );
    }
  }

  const count = (status: Outcome["status"]) =>
    outcomes.filter((outcome) => outcome.status === status).length;
  const failed = count("failed");
  const missing = count("missing");

  console.log("\n--- summary ---");
  if (apply) {
    console.log(`migrated ${count("migrated")}`);
    console.log(`reused   ${count("reused")}   (object already in the bucket)`);
  } else {
    console.log(`would migrate ${count("planned")}`);
  }
  console.log(`missing  ${missing}`);
  console.log(`failed   ${failed}`);
  console.log(
    "\nThe source directory was not modified. Keep it read-only for at least " +
      "one full backup cycle and verify production downloads before removing it.",
  );

  if (failed > 0 || missing > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
