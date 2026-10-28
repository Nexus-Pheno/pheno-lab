import "server-only";

import type { Prisma } from "@prisma/client";
import { canReadExperiment } from "@/modules/authorization/policy";
import { recordSystemAudit } from "@/modules/audit/writer";
import { notify } from "@/modules/notifications/service";
import { getTestingCompletions } from "./completion-query";
import { testingRequestSetKey } from "./request-set";

/** Acquire before changing results, requests or sample membership. */
export async function lockTestingCompletion(
  tx: Prisma.TransactionClient,
  organizationId: string,
  experimentId: string,
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`testing-completion:${organizationId}:${experimentId}`}, 0))`;
}

/** Caller holds the completion lock; delivery and its receipt commit together. */
export async function notifyTestingCompletion(
  tx: Prisma.TransactionClient,
  organizationId: string,
  experimentId: string,
): Promise<void> {
  const experiment = await tx.experiment.findFirst({
    where: { id: experimentId, organizationId, deletedAt: null, isTest: false },
    select: {
      id: true,
      organizationId: true,
      code: true,
      createdById: true,
      assigneeId: true,
      members: { select: { userId: true } },
      testingRequests: { where: { organizationId }, select: { id: true } },
    },
  });
  if (!experiment?.testingRequests.length) return;
  // One receipt per set of submitted requests. Clearing/re-saving the same
  // results never re-sends it; adding a new request starts a new batch.
  const requestSetKey = testingRequestSetKey(
    experiment.testingRequests.map((r) => r.id),
  );
  if (
    await tx.auditEvent.findFirst({
      where: {
        organizationId,
        entityType: "Experiment",
        entityId: experimentId,
        action: "testing.completed",
        metadata: { path: ["requestSetKey"], equals: requestSetKey },
      },
      select: { id: true },
    })
  )
    return;
  const completion = (
    await getTestingCompletions(tx, organizationId, [experimentId])
  ).get(experimentId);
  if (!completion?.complete) return;
  const ids = [
    ...new Set([
      experiment.createdById,
      ...(experiment.assigneeId ? [experiment.assigneeId] : []),
      ...experiment.members.map((member) => member.userId),
    ]),
  ];
  const candidates = await tx.user.findMany({
    where: {
      id: { in: ids },
      organizationId,
      active: true,
      pendingApproval: false,
      mustChangePassword: false,
      testingOnly: false,
    },
    select: { id: true, role: true },
  });
  const recipients = candidates.filter((user) =>
    canReadExperiment(
      {
        uid: user.id,
        org: organizationId,
        role: user.role,
      },
      experiment,
    ),
  );
  for (const user of recipients) {
    await notify(tx, {
      organizationId,
      userId: user.id,
      // This is a system outcome, including for a recipient who entered the
      // final result themselves, rather than a colleague's self-notification.
      actorUserId: "",
      actorName: "",
      kind: "testing_completed",
      entityLabel: experiment.code,
      href: `/experiments/${experimentId}/results`,
    });
  }
  await recordSystemAudit(tx, {
    organizationId,
    action: "testing.completed",
    entityType: "Experiment",
    entityId: experimentId,
    metadata: {
      requestSetKey,
      requestCount: experiment.testingRequests.length,
      notifiedRecipients: recipients.length,
    },
  });
}
