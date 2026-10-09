import "server-only";

import { db } from "@/infrastructure/db/client";
import { objectStorage } from "@/infrastructure/storage";
import type { Actor } from "@/modules/authorization/actor";
import { requireExperimentPermission } from "@/modules/authorization/service";
import { recordUserAudit } from "@/modules/audit/writer";
import { requireOwnedUploadKeys } from "@/modules/files/service";
import { notify } from "@/modules/notifications/service";
import { sendGroupNotice } from "@/modules/notifications/group-service";
import { isJvTesting, testingRequestSchema } from "./schema";
import { testingExperimentScope } from "./query";

export async function requestTesting(actor: Actor, raw: unknown) {
  const input = testingRequestSchema.parse(raw);
  const characterization = await db.characterization.findUniqueOrThrow({
    where: { id: input.characterizationId },
    select: {
      experimentId: true,
      name: true,
      process: { select: { name: true } },
    },
  });
  await requireExperimentPermission(
    actor,
    characterization.experimentId,
    "capture",
  );
  if (!isJvTesting(characterization.name, characterization.process.name))
    throw new Error("Select a JV testing stage.");
  await requireOwnedUploadKeys(actor, [input.photoPath]);
  const sampleIds = [...new Set(input.sampleIds)].sort();
  const result = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`testing-request:${actor.org}:${input.requestKey}`}, 0))`;
    const experiment = await tx.experiment.findFirst({
      where: {
        id: characterization.experimentId,
        organizationId: actor.org,
        deletedAt: null,
        status: "IN_LAB",
      },
      select: { id: true, code: true, isTest: true },
    });
    if (!experiment)
      throw new Error(
        "Testing can be requested only for an experiment in the lab.",
      );
    const existing = await tx.testingRequest.findUnique({
      where: {
        organizationId_requestKey: {
          organizationId: actor.org,
          requestKey: input.requestKey,
        },
      },
    });
    if (existing) {
      if (
        existing.requestedById !== actor.uid ||
        existing.characterizationId !== input.characterizationId ||
        existing.runId !== input.runId ||
        existing.photoPath !== input.photoPath ||
        existing.note !== input.note ||
        JSON.stringify(existing.sampleIds) !== JSON.stringify(sampleIds)
      )
        throw new Error("Request key was already used.");
      return { id: existing.id, created: false, isTest: experiment.isTest };
    }
    const run = await tx.run.findFirst({
      where: {
        id: input.runId,
        experimentId: experiment.id,
        status: { in: ["OPEN", "IN_PROGRESS"] },
      },
      select: { id: true },
    });
    const sampleCount = await tx.sample.count({
      where: { id: { in: sampleIds }, experimentId: experiment.id },
    });
    if (!run || sampleCount !== sampleIds.length)
      throw new Error("Run or substrates do not belong to this experiment.");
    const testers = await tx.user.findMany({
      where: {
        organizationId: actor.org,
        active: true,
        pendingApproval: false,
        testingOnly: true,
      },
      select: { id: true },
    });
    if (testers.length === 0)
      throw new Error("No active JV testing specialist is configured.");
    const row = await tx.testingRequest.create({
      data: {
        ...input,
        sampleIds,
        organizationId: actor.org,
        experimentId: experiment.id,
        requestedById: actor.uid,
      },
    });
    const sender = await tx.user.findFirstOrThrow({
      where: { id: actor.uid, organizationId: actor.org, active: true },
      select: { name: true },
    });
    for (const tester of testers)
      await notify(tx, {
        organizationId: actor.org,
        userId: tester.id,
        actorUserId: actor.uid,
        kind: "testing_requested",
        actorName: sender.name,
        entityLabel: experiment.code,
        href: `/testing/${experiment.id}#request-${row.id}`,
      });
    await recordUserAudit(tx, {
      actor,
      action: "testing.requested",
      entityType: "TestingRequest",
      entityId: row.id,
      metadata: {
        sampleCount: sampleIds.length,
        notifiedRecipients: testers.length,
      },
    });
    return { id: row.id, created: true, isTest: experiment.isTest };
  });
  const groupSent =
    result.created && !result.isTest
      ? await sendGroupNotice(actor.org, "testing_requested")
      : false;
  return { id: result.id, created: result.created, groupSent };
}

export async function readTestingPhoto(actor: Actor, requestId: string) {
  const scope = await testingExperimentScope(actor);
  const row = await db.testingRequest.findFirst({
    where: { id: requestId, organizationId: actor.org, experiment: scope },
    select: { photoPath: true },
  });
  if (!row) return null;
  const body = await objectStorage().get(row.photoPath);
  if (!body) return null;
  const extension = row.photoPath.split(".").pop()?.toLowerCase();
  const contentType =
    extension === "png"
      ? "image/png"
      : extension === "gif"
        ? "image/gif"
        : extension === "webp"
          ? "image/webp"
          : "image/jpeg";
  return { body, contentType };
}
