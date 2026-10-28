import "server-only";

import { db } from "@/infrastructure/db/client";
import type { Actor } from "@/modules/authorization/actor";
import { AuthorizationError } from "@/modules/authorization/policy";
import { recordUserAudit } from "@/modules/audit/writer";
import { testingStatusSchema } from "./schema";
import { canSetTestingStatus } from "./status-access";
import { getTestingCompletions } from "./completion-query";
import {
  lockTestingCompletion,
  notifyTestingCompletion,
} from "./completion-service";

export class TestingStatusConflict extends Error {}

export async function setTestingStatus(actor: Actor, raw: unknown) {
  const input = testingStatusSchema.parse(raw);
  return db.$transaction(async (tx) => {
    await lockTestingCompletion(tx, actor.org, input.experimentId);
    if (!(await canSetTestingStatus(tx, actor))) throw new AuthorizationError();
    const experiment = await tx.experiment.findFirst({
      where: {
        id: input.experimentId,
        organizationId: actor.org,
        deletedAt: null,
        isTest: false,
        testingRequests: { some: { organizationId: actor.org } },
      },
      select: { id: true },
    });
    if (!experiment) throw new AuthorizationError();
    const before = (
      await getTestingCompletions(tx, actor.org, [experiment.id])
    ).get(experiment.id)!;
    // A stale browser must not mark newly submitted work as already finished.
    if (before.requestSetKey !== input.requestSetKey)
      throw new TestingStatusConflict();
    if (input.status === "AUTO") {
      await tx.testingStatusOverride.deleteMany({
        where: { experimentId: experiment.id, organizationId: actor.org },
      });
    } else {
      const data = {
        organizationId: actor.org,
        requestSetKey: input.requestSetKey,
        status: input.status,
        reason: input.reason,
        changedById: actor.uid,
      };
      await tx.testingStatusOverride.upsert({
        where: { experimentId: experiment.id },
        create: { ...data, experimentId: experiment.id },
        update: data,
      });
    }
    const complete =
      input.status === "AUTO"
        ? before.automaticComplete
        : input.status === "COMPLETE";
    await recordUserAudit(tx, {
      actor,
      action: "testing.status_set",
      entityType: "Experiment",
      entityId: experiment.id,
      changes: {
        before: {
          complete: before.complete,
          source: before.manual ? "MANUAL" : "AUTO",
        },
        after: { complete, status: input.status },
      },
      metadata: { requestSetKey: input.requestSetKey, reason: input.reason },
    });
    await notifyTestingCompletion(tx, actor.org, experiment.id);
    return { experimentId: experiment.id };
  });
}
