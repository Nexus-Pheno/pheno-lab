import "server-only";

import { db } from "@/infrastructure/db/client";
import type { Actor } from "@/modules/authorization/actor";
import { recordUserAudit } from "@/modules/audit/writer";
import {
  refreshExperimentSerials,
  syncSampleSerials,
} from "@/modules/instruments/sample-serial-service";
import { assertEdit } from "./access";
import { experimentIdSchema, sampleSetSchema } from "./schema";

// ---- Members / access ----

export async function addMember(
  actor: Actor,
  experimentId: string,
  userId: string,
) {
  experimentId = experimentIdSchema.parse(experimentId);
  userId = experimentIdSchema.parse(userId);
  await assertEdit(actor, experimentId);
  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: { organizationId: true },
  });
  if (user.organizationId !== actor.org)
    throw new Error("User belongs to another organization.");
  await db.$transaction(async (tx) => {
    await tx.experimentMember.upsert({
      where: { experimentId_userId: { experimentId, userId } },
      update: {},
      create: { experimentId, userId },
    });
    await recordUserAudit(tx, {
      actor,
      action: "experiment.member.add",
      entityType: "Experiment",
      entityId: experimentId,
      changes: { userId },
    });
  });
  return db.experimentMember.findMany({
    where: { experimentId },
    include: {
      user: { select: { id: true, name: true, email: true, role: true } },
    },
  });
}

export async function removeMember(
  actor: Actor,
  experimentId: string,
  userId: string,
) {
  experimentId = experimentIdSchema.parse(experimentId);
  userId = experimentIdSchema.parse(userId);
  await assertEdit(actor, experimentId);
  await db.$transaction(async (tx) => {
    await tx.experimentMember.deleteMany({ where: { experimentId, userId } });
    await recordUserAudit(tx, {
      actor,
      action: "experiment.member.remove",
      entityType: "Experiment",
      entityId: experimentId,
      changes: { userId },
    });
  });
  return db.experimentMember.findMany({
    where: { experimentId },
    include: {
      user: { select: { id: true, name: true, email: true, role: true } },
    },
  });
}

// ---- Samples ----

export async function setSamples(
  actor: Actor,
  experimentId: string,
  rawSamples: unknown,
) {
  experimentId = experimentIdSchema.parse(experimentId);
  const samples = sampleSetSchema.parse(rawSamples);
  await assertEdit(actor, experimentId);
  await db.$transaction(async (tx) => {
    await tx.sample.deleteMany({ where: { experimentId } });
    await tx.sample.createMany({
      data: samples.map((s) => ({
        experimentId,
        code: s.code,
        variationGroup: s.variationGroup,
      })),
    });
    await syncSampleSerials(tx, experimentId);
    await recordUserAudit(tx, {
      actor,
      action: "experiment.samples.replace",
      entityType: "Experiment",
      entityId: experimentId,
      changes: { samples },
    });
  });
  // Rebuilding the sample set strands any measurement that pointed at the old
  // rows; re-matching puts them back on the same serial.
  await refreshExperimentSerials(experimentId);
  return db.sample.findMany({
    where: { experimentId },
    orderBy: { code: "asc" },
  });
}
