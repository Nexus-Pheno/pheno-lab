import "server-only";

import bcrypt from "bcryptjs";
import { db } from "@/infrastructure/db/client";
import type { Actor } from "@/modules/authorization/actor";
import { assertAdmin } from "@/modules/authorization/policy";
import { recordUserAudit } from "@/modules/audit/writer";
import {
  feedbackSchema,
  feedbackStatusSchema,
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

export async function submitFeedback(actor: Actor, raw: unknown) {
  const input = feedbackSchema.parse(raw);
  return db.$transaction(async (tx) => {
    const row = await tx.feedback.create({
      data: {
        organizationId: actor.org,
        userId: actor.uid,
        ...input,
      },
    });
    await recordUserAudit(tx, {
      actor,
      action: "feedback.created",
      entityType: "Feedback",
      entityId: row.id,
      metadata: { kind: row.kind, pageUrl: row.pageUrl },
    });
    return row;
  });
}

export async function setFeedbackStatus(actor: Actor, raw: unknown) {
  assertAdmin(actor);
  const input = feedbackStatusSchema.parse(raw);
  await db.$transaction(async (tx) => {
    const result = await tx.feedback.updateMany({
      where: { id: input.id, organizationId: actor.org },
      data: { status: input.status },
    });
    if (result.count !== 1) throw new Error("Feedback not found.");
    await recordUserAudit(tx, {
      actor,
      action: "feedback.status.updated",
      entityType: "Feedback",
      entityId: input.id,
      changes: { status: input.status },
    });
  });
}
