import "server-only";

import bcrypt from "bcryptjs";
import { db } from "@/infrastructure/db/client";
import { objectStorage } from "@/infrastructure/storage";
import type { Actor } from "@/modules/authorization/actor";
import { assertAdmin } from "@/modules/authorization/policy";
import { recordUserAudit } from "@/modules/audit/writer";
import {
  feedbackReviewSchema,
  feedbackSchema,
  languageSchema,
  passwordChangeSchema,
  profileSchema,
} from "./schema";

export async function updateProfile(actor: Actor, raw: unknown) {
  const data = profileSchema.parse(raw);
  await db.$transaction(async (tx) => {
    const result = await tx.user.updateMany({
      where: { id: actor.uid, organizationId: actor.org, active: true },
      data,
    });
    if (result.count !== 1) throw new Error("Active user not found.");
    await recordUserAudit(tx, {
      actor,
      action: "user.profile.updated",
      entityType: "User",
      entityId: actor.uid,
      changes: data,
    });
  });
  return data;
}

export async function changePassword(
  actor: Actor,
  raw: unknown,
): Promise<{ ok: boolean; error?: string }> {
  const input = passwordChangeSchema.safeParse(raw);
  if (!input.success) return { ok: false, error: "too-short" };
  const user = await db.user.findFirstOrThrow({
    where: { id: actor.uid, organizationId: actor.org, active: true },
    select: { passwordHash: true },
  });
  if (!(await bcrypt.compare(input.data.current, user.passwordHash))) {
    return { ok: false, error: "wrong-current" };
  }
  const passwordHash = await bcrypt.hash(input.data.next, 10);
  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: actor.uid },
      data: { passwordHash },
    });
    await recordUserAudit(tx, {
      actor,
      action: "user.password.changed",
      entityType: "User",
      entityId: actor.uid,
    });
  });
  return { ok: true };
}

export async function setLanguage(actor: Actor, raw: unknown) {
  const language = languageSchema.parse(raw);
  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: actor.uid, organizationId: actor.org },
      data: { language },
    });
    await recordUserAudit(tx, {
      actor,
      action: "user.language.updated",
      entityType: "User",
      entityId: actor.uid,
      changes: { language },
    });
  });
  return language;
}

/** Screenshots must be the actor's own fresh uploads — same rule as capture. */
async function requireOwnedUploadKeys(
  actor: Actor,
  keys: string[],
): Promise<void> {
  const prefix = `organizations/${actor.org}/users/${actor.uid}/images/`;
  for (const key of keys) {
    if (!key.startsWith(prefix) || !(await objectStorage().exists(key))) {
      throw new Error(
        "A screenshot is missing or does not belong to this user.",
      );
    }
  }
}

export async function submitFeedback(actor: Actor, raw: unknown) {
  const { photoFileNames, ...input } = feedbackSchema.parse(raw);
  await requireOwnedUploadKeys(actor, photoFileNames);
  return db.$transaction(async (tx) => {
    const row = await tx.feedback.create({
      data: {
        organizationId: actor.org,
        userId: actor.uid,
        ...input,
      },
    });
    if (photoFileNames.length > 0) {
      await tx.attachment.createMany({
        data: photoFileNames.map((key) => ({
          feedbackId: row.id,
          fileName: key.split("/").pop() ?? key,
          storedPath: key,
          mime: "image/*",
          size: 0,
        })),
      });
    }
    await recordUserAudit(tx, {
      actor,
      action: "feedback.created",
      entityType: "Feedback",
      entityId: row.id,
      metadata: {
        kind: row.kind,
        pageUrl: row.pageUrl,
        screenshots: photoFileNames.length,
      },
    });
    return row;
  });
}

/** Triage: status changes, admin comments, and wording edits — audited. */
export async function reviewFeedback(actor: Actor, raw: unknown) {
  assertAdmin(actor);
  const { id, ...patch } = feedbackReviewSchema.parse(raw);
  await db.$transaction(async (tx) => {
    const result = await tx.feedback.updateMany({
      where: { id, organizationId: actor.org },
      data: {
        ...patch,
        ...(patch.status
          ? { reviewedById: actor.uid, reviewedAt: new Date() }
          : {}),
      },
    });
    if (result.count !== 1) throw new Error("Feedback not found.");
    await recordUserAudit(tx, {
      actor,
      action: "feedback.reviewed",
      entityType: "Feedback",
      entityId: id,
      changes: patch,
    });
  });
}
