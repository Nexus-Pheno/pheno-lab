"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireSession, requireStaff } from "@/lib/auth";

// Assignment and sign-off: a manager assigns a technician and sends the
// experiment to the lab; the assignee submits it for review when the work is
// done; the manager approves it, adding closing notes, which seals the
// evidence pack (plan + captures + results) and closes the experiment.

async function loadForWorkflow(id: string) {
  const session = await requireSession();
  const exp = await db.experiment.findUniqueOrThrow({
    where: { id },
    select: {
      id: true, organizationId: true, createdById: true, status: true,
      assigneeId: true, members: { select: { userId: true } },
    },
  });
  if (exp.organizationId !== session.org) throw new Error("Experiment belongs to another organization.");
  return { session, exp };
}

/** Manager/admin: designate who runs the experiment. Adds them as a member. */
export async function assignExperiment(id: string, userId: string | null) {
  const { session, exp } = await loadForWorkflow(id);
  if (session.role === "TECHNICIAN") throw new Error("Only managers can assign experiments.");
  if (session.role === "MANAGER" && exp.createdById !== session.uid && !exp.members.some((m) => m.userId === session.uid)) {
    throw new Error("You are not involved in this experiment.");
  }
  if (userId) {
    const user = await db.user.findFirst({ where: { id: userId, organizationId: session.org, active: true } });
    if (!user) throw new Error("Unknown user.");
    // The assignee must be able to open it in the capture portal.
    await db.experimentMember.upsert({
      where: { experimentId_userId: { experimentId: id, userId } },
      create: { experimentId: id, userId },
      update: {},
    });
  }
  await db.experiment.update({ where: { id }, data: { assigneeId: userId } });
  revalidatePath("/");
}

/** Manager/admin: release to the lab. Requires an assignee. */
export async function startLabWork(id: string) {
  const { session, exp } = await loadForWorkflow(id);
  if (session.role === "TECHNICIAN") throw new Error("Only managers can start lab work.");
  if (!exp.assigneeId) throw new Error("Assign someone to run this experiment first.");
  await db.experiment.update({ where: { id }, data: { status: "IN_LAB" } });
  revalidatePath("/");
}

/** Assignee (or any member): hand the finished work back for review. */
export async function submitForReview(id: string, note: string) {
  const { session, exp } = await loadForWorkflow(id);
  const involved =
    session.role === "ADMIN" ||
    exp.assigneeId === session.uid ||
    exp.createdById === session.uid ||
    exp.members.some((m) => m.userId === session.uid);
  if (!involved) throw new Error("You are not assigned to this experiment.");
  if (exp.status !== "IN_LAB") throw new Error("Only experiments in the lab can be submitted.");
  await db.experiment.update({
    where: { id },
    data: { status: "REVIEW", submittedAt: new Date(), submitNote: note.trim() },
  });
  revalidatePath("/");
}

/** Manager/admin: approve the run — closes the experiment with sign-off notes. */
export async function approveExperiment(id: string, reviewNote: string) {
  const session = await requireStaff();
  const { exp } = await loadForWorkflow(id);
  if (exp.status !== "REVIEW") throw new Error("This experiment is not awaiting review.");
  if (session.role === "MANAGER" && exp.createdById !== session.uid && !exp.members.some((m) => m.userId === session.uid)) {
    throw new Error("You are not involved in this experiment.");
  }
  await db.experiment.update({
    where: { id },
    data: {
      status: "COMPLETE",
      approvedAt: new Date(),
      approvedById: session.uid,
      reviewNote: reviewNote.trim(),
    },
  });
  revalidatePath("/");
}

/** Manager/admin: send it back to the lab with feedback. */
export async function requestChanges(id: string, reviewNote: string) {
  const session = await requireStaff();
  const { exp } = await loadForWorkflow(id);
  if (exp.status !== "REVIEW") throw new Error("This experiment is not awaiting review.");
  await db.experiment.update({
    where: { id },
    data: { status: "IN_LAB", reviewNote: reviewNote.trim(), submittedAt: null },
  });
  revalidatePath("/");
}
