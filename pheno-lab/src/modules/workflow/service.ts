import "server-only";

import { db } from "@/infrastructure/db/client";
import { assertExperimentPermission } from "@/modules/authorization/policy";
import { recordUserAudit } from "@/modules/audit/writer";
import type { Actor } from "@/modules/authorization/actor";
import { assertStaff } from "@/modules/authorization/policy";
import {
  assignmentSchema,
  workflowIdSchema,
  workflowNoteSchema,
} from "./schema";

// Assignment and sign-off: a manager assigns a technician and sends the
// experiment to the lab; the assignee submits it for review when the work is
// done; the manager approves it, adding closing notes, which seals the
// evidence pack (plan + captures + results) and closes the experiment.

async function loadForWorkflow(actor: Actor, id: string) {
  const exp = await db.experiment.findUniqueOrThrow({
    where: { id },
    select: {
      id: true,
      organizationId: true,
      createdById: true,
      status: true,
      assigneeId: true,
      members: { select: { userId: true } },
    },
  });
  if (exp.organizationId !== actor.org)
    throw new Error("Experiment belongs to another organization.");
  return exp;
}

/** Manager/admin: designate who runs the experiment. Adds them as a member. */
export async function assignExperiment(actor: Actor, raw: unknown) {
  const { experimentId: id, userId } = assignmentSchema.parse(raw);
  const exp = await loadForWorkflow(actor, id);
  assertExperimentPermission(actor, exp, "manage");
  if (userId) {
    const user = await db.user.findFirst({
      where: { id: userId, organizationId: actor.org, active: true },
    });
    if (!user) throw new Error("Unknown user.");
  }
  await db.$transaction(async (transaction) => {
    if (userId) {
      // The assignee must be able to open it in the capture portal.
      await transaction.experimentMember.upsert({
        where: { experimentId_userId: { experimentId: id, userId } },
        create: { experimentId: id, userId },
        update: {},
      });
    }
    await transaction.experiment.update({
      where: { id },
      data: { assigneeId: userId },
    });
    await recordUserAudit(transaction, {
      actor,
      action: "experiment.assign",
      entityType: "Experiment",
      entityId: id,
      changes: { assigneeId: userId },
    });
  });
}

/** Manager/admin: release to the lab. Requires an assignee. */
export async function startLabWork(actor: Actor, rawId: unknown) {
  const id = workflowIdSchema.parse(rawId);
  const exp = await loadForWorkflow(actor, id);
  assertExperimentPermission(actor, exp, "manage");
  if (!exp.assigneeId)
    throw new Error("Assign someone to run this experiment first.");
  await db.$transaction(async (transaction) => {
    await transaction.experiment.update({
      where: { id },
      data: { status: "IN_LAB" },
    });
    await recordUserAudit(transaction, {
      actor,
      action: "experiment.start-lab-work",
      entityType: "Experiment",
      entityId: id,
      changes: { status: "IN_LAB" },
    });
  });
}

/** Assignee (or any member): hand the finished work back for review. */
export async function submitForReview(
  actor: Actor,
  rawId: unknown,
  rawNote: unknown,
) {
  const id = workflowIdSchema.parse(rawId);
  const note = workflowNoteSchema.parse(rawNote);
  const exp = await loadForWorkflow(actor, id);
  assertExperimentPermission(actor, exp, "submit");
  if (exp.status !== "IN_LAB")
    throw new Error("Only experiments in the lab can be submitted.");
  await db.$transaction(async (transaction) => {
    await transaction.experiment.update({
      where: { id },
      data: {
        status: "REVIEW",
        submittedAt: new Date(),
        submitNote: note,
      },
    });
    await recordUserAudit(transaction, {
      actor,
      action: "experiment.submit-review",
      entityType: "Experiment",
      entityId: id,
      changes: { status: "REVIEW", submitNote: note },
    });
  });
}

/** Manager/admin: approve the run — closes the experiment with sign-off notes. */
export async function approveExperiment(
  actor: Actor,
  rawId: unknown,
  rawNote: unknown,
) {
  assertStaff(actor);
  const id = workflowIdSchema.parse(rawId);
  const reviewNote = workflowNoteSchema.parse(rawNote);
  const exp = await loadForWorkflow(actor, id);
  assertExperimentPermission(actor, exp, "manage");
  if (exp.status !== "REVIEW")
    throw new Error("This experiment is not awaiting review.");
  await db.$transaction(async (transaction) => {
    await transaction.experiment.update({
      where: { id },
      data: {
        status: "COMPLETE",
        approvedAt: new Date(),
        approvedById: actor.uid,
        reviewNote,
      },
    });
    await recordUserAudit(transaction, {
      actor,
      action: "experiment.approve",
      entityType: "Experiment",
      entityId: id,
      changes: { status: "COMPLETE", reviewNote },
    });
  });
}

/** Manager/admin: send it back to the lab with feedback. */
export async function requestChanges(
  actor: Actor,
  rawId: unknown,
  rawNote: unknown,
) {
  assertStaff(actor);
  const id = workflowIdSchema.parse(rawId);
  const reviewNote = workflowNoteSchema.parse(rawNote);
  const exp = await loadForWorkflow(actor, id);
  assertExperimentPermission(actor, exp, "manage");
  if (exp.status !== "REVIEW")
    throw new Error("This experiment is not awaiting review.");
  await db.$transaction(async (transaction) => {
    await transaction.experiment.update({
      where: { id },
      data: {
        status: "IN_LAB",
        reviewNote,
        submittedAt: null,
      },
    });
    await recordUserAudit(transaction, {
      actor,
      action: "experiment.request-changes",
      entityType: "Experiment",
      entityId: id,
      changes: { status: "IN_LAB", reviewNote },
    });
  });
}
