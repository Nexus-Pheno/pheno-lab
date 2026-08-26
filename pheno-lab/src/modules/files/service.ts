import "server-only";

import crypto from "node:crypto";
import path from "node:path";
import { objectStorage } from "@/infrastructure/storage";
import { db } from "@/infrastructure/db/client";
import type { Actor } from "@/modules/authorization/actor";
import { recordUserAudit } from "@/modules/audit/writer";
import { canReadObject } from "./authorization";
import {
  DOCUMENT_EXTENSIONS,
  documentUploadSchema,
  imageUploadSchema,
} from "./schema";

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".txt": "text/plain",
};

async function storeUserFile(
  actor: Actor,
  file: File,
  folder: "images" | "documents",
  extension: string,
) {
  const now = new Date();
  const key = [
    "organizations",
    actor.org,
    "users",
    actor.uid,
    folder,
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    crypto.randomUUID() + extension,
  ].join("/");
  const storage = objectStorage();
  await storage.put({
    key,
    body: Buffer.from(await file.arrayBuffer()),
    contentType: file.type,
  });
  try {
    await recordUserAudit(db, {
      actor,
      action: "file.uploaded",
      entityType: "Object",
      entityId: key,
      metadata: { contentType: file.type, size: file.size },
    });
  } catch (error) {
    // A random upload key has no other owner yet, so compensating deletion is
    // safe and prevents an unaudited orphan when the database write fails.
    await storage.delete(key).catch(() => undefined);
    throw error;
  }
  return key;
}

export async function storeImage(actor: Actor, raw: unknown) {
  const file = imageUploadSchema.parse(raw);
  const extension = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
  }[file.type]!;
  return storeUserFile(actor, file, "images", extension);
}

export async function storeDocument(actor: Actor, raw: unknown) {
  const file = documentUploadSchema.parse(raw);
  const extension =
    DOCUMENT_EXTENSIONS[file.type as keyof typeof DOCUMENT_EXTENSIONS];
  const storedPath = await storeUserFile(actor, file, "documents", extension);
  // The original file name is not part of the key — a vendor datasheet called
  // "规格书.pdf" must stay readable, and the key stays ASCII-safe.
  return { fileName: file.name, storedPath, mime: file.type, size: file.size };
}

export async function readObject(actor: Actor, key: string) {
  if (!(await canReadObject(actor, key))) return null;
  const body = await objectStorage().get(key);
  if (!body) return null;
  return {
    body,
    contentType:
      MIME[path.extname(key).toLowerCase()] ?? "application/octet-stream",
  };
}
