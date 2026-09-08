import "server-only";

import bcrypt from "bcryptjs";
import { db } from "@/infrastructure/db/client";
import { objectStorage } from "@/infrastructure/storage";
import type { Actor } from "@/modules/authorization/actor";
import { assertAdmin } from "@/modules/authorization/policy";
import { recordSystemAudit, recordUserAudit } from "@/modules/audit/writer";
import { notify, type NotificationKind } from "@/modules/notifications/service";
import {
  feedbackReviewSchema,
  feedbackSchema,
  feedbackVerifySchema,
  languageSchema,
  passwordChangeSchema,
  profileSchema,
} from "./schema";

// A reporter has this long to test an implemented item before it goes green
// on its own (Michael, 2026-09-08).
const VERIFY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

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
        // Marking implemented (re)starts the reporter's 7-day verification
        // window and clears any previous verdict.
        ...(patch.status === "implemented"
          ? {
              implementedAt: new Date(),
              verifiedAt: null,
              verifiedAuto: false,
              disputeNote: "",
            }
          : {}),
      },
    });
    if (result.count !== 1) throw new Error("Feedback not found.");
    // Tell the submitter their item was answered — a verdict or a comment.
    const feedback = await tx.feedback.findUniqueOrThrow({
      where: { id },
      select: { userId: true, title: true, message: true },
    });
    const kind: NotificationKind | null =
      patch.status === "approved"
        ? "feedback_approved"
        : patch.status === "rejected"
          ? "feedback_rejected"
          : patch.status === "implemented"
            ? "feedback_implemented"
            : patch.adminNote
              ? "feedback_commented"
              : null;
    if (kind) {
      const reviewer = await tx.user.findUniqueOrThrow({
        where: { id: actor.uid },
        select: { name: true },
      });
      await notify(tx, {
        organizationId: actor.org,
        userId: feedback.userId,
        actorUserId: actor.uid,
        kind,
        actorName: reviewer.name,
        entityLabel: feedback.title || feedback.message.slice(0, 80),
        href: "/profile",
      });
    }
    await recordUserAudit(tx, {
      actor,
      action: "feedback.reviewed",
      entityType: "Feedback",
      entityId: id,
      changes: patch,
    });
  });
}

/**
 * The reporter's verdict on an implemented item: green-light it (verified)
 * or reopen it with a reason, which puts it back in the admin's queue.
 */
export async function verifyFeedback(actor: Actor, raw: unknown) {
  const { id, accept, note } = feedbackVerifySchema.parse(raw);
  await db.$transaction(async (tx) => {
    const feedback = await tx.feedback.findFirst({
      where: { id, organizationId: actor.org },
      select: {
        userId: true,
        status: true,
        title: true,
        message: true,
        reviewedById: true,
      },
    });
    if (!feedback) throw new Error("Feedback not found.");
    if (feedback.userId !== actor.uid)
      throw new Error("Only the reporter can verify their feedback.");
    if (feedback.status !== "implemented")
      throw new Error("Only implemented feedback can be verified.");

    await tx.feedback.update({
      where: { id },
      data: accept
        ? { status: "verified", verifiedAt: new Date(), verifiedAuto: false }
        : { status: "reopened", disputeNote: note },
    });
    if (feedback.reviewedById) {
      const reporter = await tx.user.findUniqueOrThrow({
        where: { id: actor.uid },
        select: { name: true },
      });
      await notify(tx, {
        organizationId: actor.org,
        userId: feedback.reviewedById,
        actorUserId: actor.uid,
        kind: accept ? "feedback_verified" : "feedback_reopened",
        actorName: reporter.name,
        entityLabel: feedback.title || feedback.message.slice(0, 80),
        href: "/feedback",
      });
    }
    await recordUserAudit(tx, {
      actor,
      action: accept ? "feedback.verified" : "feedback.disputed",
      entityType: "Feedback",
      entityId: id,
      // The dispute reason lives on the row; the audit only marks the event.
      changes: { accept },
    });
  });
}

/**
 * Implemented items nobody responded to within the window go green on their
 * own. Called lazily from the feedback lists — no cron needed, and a board
 * nobody opens simply settles a little later.
 */
export async function autoVerifyFeedback(organizationId: string) {
  const cutoff = new Date(Date.now() - VERIFY_WINDOW_MS);
  const stale = await db.feedback.findMany({
    where: {
      organizationId,
      status: "implemented",
      implementedAt: { lt: cutoff },
    },
    select: { id: true },
  });
  if (stale.length === 0) return;
  await db.$transaction(async (tx) => {
    await tx.feedback.updateMany({
      where: { id: { in: stale.map((row) => row.id) } },
      data: { status: "verified", verifiedAt: new Date(), verifiedAuto: true },
    });
    await recordSystemAudit(tx, {
      organizationId,
      action: "feedback.auto_verified",
      entityType: "Organization",
      entityId: organizationId,
      metadata: { count: stale.length },
    });
  });
}
