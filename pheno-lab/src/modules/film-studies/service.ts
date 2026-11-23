import "server-only";
import { createHash } from "node:crypto";
import { db } from "@/infrastructure/db/client";
import { objectStorage } from "@/infrastructure/storage";
import type { Actor } from "@/modules/authorization/actor";
import { recordUserAudit } from "@/modules/audit/writer";
import { requireStudies } from "./access";
import { manifest, partSize, partCount, StudyError } from "./schema";

export const fileInfo = {
  id: true,
  ordinal: true,
  name: true,
  size: true,
} as const;
export const studyInfo = {
  id: true,
  method: true,
  customMethod: true,
  notes: true,
  createdAt: true,
  measuredOn: true,
  publishedAt: true,
  author: { select: { name: true } },
  materials: { select: { id: true, name: true } },
  interpretation: true,
  files: { orderBy: { ordinal: "asc" }, select: fileInfo },
} as const;
const hash = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const objectKey = (org: string, file: string, n: number, digest: string) =>
  `organizations/${org}/film-studies/${file}/${n}-${digest}`;
export async function beginStudy(actor: Actor, raw: unknown) {
  const data = manifest.parse(raw);
  const materialIds = [...new Set(data.materialIds)].sort();
  const manifestHash = hash(JSON.stringify({ ...data, materialIds }));
  return db.$transaction(async (tx) => {
    await requireStudies(actor, tx);
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"film-study:" + data.id},0))::text`;
    const existing = await tx.filmStudy.findUnique({
      where: { id: data.id },
      select: { authorId: true, organizationId: true, manifestHash: true },
    });
    if (
      existing &&
      (existing.authorId !== actor.uid ||
        existing.organizationId !== actor.org ||
        existing.manifestHash !== manifestHash)
    )
      throw new StudyError("conflict");
    if (!existing) {
      const valid = await tx.material.count({
        where: {
          id: { in: materialIds },
          organizationId: actor.org,
          archived: false,
        },
      });
      if (valid !== materialIds.length) throw new StudyError("invalid");
      await tx.filmStudy.create({
        data: {
          id: data.id,
          authorId: actor.uid,
          organizationId: actor.org,
          method: data.method,
          measuredOn: data.measuredOn ? new Date(data.measuredOn) : null,
          customMethod: data.customMethod,
          notes: data.notes,
          manifestHash,
          materials: { connect: materialIds.map((id) => ({ id })) },
          files: {
            create: data.files.map((file, ordinal) => ({ ...file, ordinal })),
          },
        },
      });
      await recordUserAudit(tx, {
        actor,
        action: "filmStudy.started",
        entityType: "FilmStudy",
        entityId: data.id,
        metadata: { fileCount: data.files.length },
      });
    }
    return tx.filmStudy.findUniqueOrThrow({
      where: { id: data.id },
      select: {
        id: true,
        publishedAt: true,
        files: {
          select: {
            ...fileInfo,
            parts: {
              where: { ready: true },
              select: { number: true, sha256: true },
            },
          },
          orderBy: { ordinal: "asc" },
        },
      },
    });
  });
}

export async function savePart(
  actor: Actor,
  fileId: string,
  number: number,
  body: Uint8Array,
) {
  await requireStudies(actor);
  const file = await db.filmStudyFile.findFirst({
    where: {
      id: fileId,
      study: { organizationId: actor.org, authorId: actor.uid },
    },
    select: { size: true, study: { select: { publishedAt: true } } },
  });
  if (!file) throw new StudyError("missing");
  if (!body.length || partSize(file.size, number) !== body.length)
    throw new StudyError("invalid");
  const sha256 = hash(body);
  const where = { fileId_number: { fileId, number } };
  // Reserve an immutable digest before writing storage. Retries can complete the same reservation.
  await db.filmStudyPart.createMany({
    data: [{ fileId, number, sha256 }],
    skipDuplicates: true,
  });
  const part = await db.filmStudyPart.findUniqueOrThrow({ where });
  if (part.sha256 !== sha256) throw new StudyError("conflict");
  if (part.ready) return;
  if (file.study.publishedAt) throw new StudyError("conflict");
  await objectStorage().put({
    key: objectKey(actor.org, fileId, number, sha256),
    body,
    contentType: "application/octet-stream",
    sha256,
  });
  await db.filmStudyPart.update({ where, data: { ready: true } });
}

export async function finishStudy(actor: Actor, id: string) {
  return db.$transaction(async (tx) => {
    await requireStudies(actor, tx);
    await tx.$queryRaw`SELECT id FROM "FilmStudy" WHERE id=${id} AND "organizationId"=${actor.org} AND "authorId"=${actor.uid} FOR UPDATE`;
    const row = await tx.filmStudy.findFirst({
      where: { id, organizationId: actor.org, authorId: actor.uid },
      select: {
        publishedAt: true,
        files: {
          select: {
            size: true,
            _count: { select: { parts: { where: { ready: true } } } },
          },
        },
      },
    });
    if (!row) throw new StudyError("missing");
    if (row.publishedAt) return;
    if (
      !row.files.length ||
      row.files.some((f) => f._count.parts !== partCount(f.size))
    )
      throw new StudyError("incomplete");
    await tx.filmStudy.update({
      where: { id },
      data: { publishedAt: new Date() },
    });
    await recordUserAudit(tx, {
      actor,
      action: "filmStudy.saved",
      entityType: "FilmStudy",
      entityId: id,
      metadata: { fileCount: row.files.length },
    });
  });
}

// Callers must check the portal or research-key grant before resolving an original.
export async function findStudyFile(org: string, id: string) {
  return db.filmStudyFile.findFirst({
    where: { id, study: { organizationId: org, publishedAt: { not: null } } },
    select: fileInfo,
  });
}
export async function readStudyPart(
  org: string,
  file: { id: string; size: number },
  number: number,
) {
  if (!partSize(file.size, number)) throw new StudyError("invalid");
  const part = await db.filmStudyPart.findFirst({
    where: {
      fileId: file.id,
      number,
      ready: true,
      file: { study: { organizationId: org, publishedAt: { not: null } } },
    },
    select: { sha256: true },
  });
  if (!part) throw new StudyError("missing");
  const bytes = await objectStorage().get(
    objectKey(org, file.id, number, part.sha256),
  );
  if (
    !bytes ||
    bytes.length !== partSize(file.size, number) ||
    hash(bytes) !== part.sha256
  )
    throw new Error("Original file integrity check failed");
  return { bytes, sha256: part.sha256 };
}
