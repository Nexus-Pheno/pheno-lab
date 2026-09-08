import "server-only";

import { db } from "@/infrastructure/db/client";
import type { Actor } from "@/modules/authorization/actor";
import { canReadExperiment } from "@/modules/authorization/policy";
import { requireExperimentPermission } from "@/modules/authorization/service";
import { recordUserAudit } from "@/modules/audit/writer";
import { notify } from "@/modules/notifications/service";
import { sendGroupNotice } from "@/modules/notifications/group-service";
import {
  accessDecisionSchema,
  accessRequestSchema,
  experimentIdSchema,
} from "./schema";

// The knock on the door: a technician who clicks a colleague's experiment
// lands on a request-access page instead of a 404. The owner (or any
// manager/admin) approves — which simply adds them as a member, so every
// existing permission path lights up — or declines.

const RESOURCE_SELECT = {
  organizationId: true,
  createdById: true,
  assigneeId: true,
  members: { select: { userId: true } },
} as const;

export type ExperimentPeek = {
  id: string;
  code: string;
  title: string;
  status: string;
  owner: string;
  createdAt: string;
  /** The actor's latest request, if any. */
  myRequest: { status: string; createdAt: string } | null;
};

/**
 * The metadata shown on the request-access page — never the contents. Returns
 * null when the experiment does not exist in the actor's organization (or is
 * a test experiment), which the page turns into a plain 404.
 */
export async function getExperimentPeek(
  actor: Actor,
  rawId: unknown,
): Promise<ExperimentPeek | null> {
  const id = experimentIdSchema.parse(rawId);
  const experiment = await db.experiment.findFirst({
    where: { id, organizationId: actor.org, isTest: false, deletedAt: null },
    select: {
      id: true,
      code: true,
      title: true,
      status: true,
      createdAt: true,
      createdBy: { select: { name: true } },
      accessRequests: {
        where: { requesterId: actor.uid },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { status: true, createdAt: true },
      },
    },
  });
  if (!experiment) return null;
  const mine = experiment.accessRequests[0];
  return {
    id: experiment.id,
    code: experiment.code,
    title: experiment.title,
    status: experiment.status,
    owner: experiment.createdBy.name,
    createdAt: experiment.createdAt.toISOString().slice(0, 10),
    myRequest: mine
      ? {
          status: mine.status,
          createdAt: mine.createdAt
            .toISOString()
            .slice(0, 16)
            .replace("T", " "),
        }
      : null,
  };
}

export async function requestAccess(actor: Actor, raw: unknown): Promise<void> {
  const { experimentId, message } = accessRequestSchema.parse(raw);
  const created = await db.$transaction(async (tx) => {
    const resource = await tx.experiment.findFirst({
      where: {
        id: experimentId,
        organizationId: actor.org,
        isTest: false,
        deletedAt: null,
      },
      select: RESOURCE_SELECT,
    });
    if (!resource) throw new Error("No such experiment.");
    if (canReadExperiment(actor, resource))
      throw new Error("You already have access to this experiment.");
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`access-request:${actor.org}:${experimentId}:${actor.uid}`}, 0))`;
    const open = await tx.accessRequest.findFirst({
      where: { experimentId, requesterId: actor.uid, status: "open" },
      select: { id: true },
    });
    if (open) return; // Idempotent: the knock is already on the door.
    await tx.accessRequest.create({
      data: { experimentId, requesterId: actor.uid, message },
    });
    const [requester, experiment] = await Promise.all([
      tx.user.findUniqueOrThrow({
        where: { id: actor.uid },
        select: { name: true },
      }),
      tx.experiment.findUniqueOrThrow({
        where: { id: experimentId },
        select: { code: true, title: true },
      }),
    ]);
    await notify(tx, {
      organizationId: actor.org,
      userId: resource.createdById,
      actorUserId: actor.uid,
      kind: "access_requested",
      actorName: requester.name,
      entityLabel: `${experiment.code} · ${experiment.title}`,
      href: `/experiments/${experimentId}`,
    });
    await recordUserAudit(tx, {
      actor,
      action: "experiment.access_requested",
      entityType: "Experiment",
      entityId: experimentId,
      changes: {},
    });
    return true;
  });
  if (created) await sendGroupNotice(actor.org, "access_requested");
}

export type OpenAccessRequest = {
  id: string;
  requester: string;
  message: string;
  createdAt: string;
};

/** Pending knocks on an experiment the actor can manage. */
export async function listOpenRequests(
  actor: Actor,
  rawExperimentId: unknown,
): Promise<OpenAccessRequest[]> {
  const experimentId = experimentIdSchema.parse(rawExperimentId);
  await requireExperimentPermission(actor, experimentId, "manage");
  const rows = await db.accessRequest.findMany({
    where: { experimentId, status: "open" },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      message: true,
      createdAt: true,
      requester: { select: { name: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    requester: r.requester.name,
    message: r.message,
    createdAt: r.createdAt.toISOString().slice(0, 16).replace("T", " "),
  }));
}

/** Approve (adds membership) or decline a pending request. */
export async function decideAccessRequest(
  actor: Actor,
  raw: unknown,
): Promise<void> {
  const { requestId, approve } = accessDecisionSchema.parse(raw);
  const request = await db.accessRequest.findUniqueOrThrow({
    where: { id: requestId },
    select: { id: true, experimentId: true, requesterId: true, status: true },
  });
  if (request.status !== "open") return;
  await requireExperimentPermission(actor, request.experimentId, "manage");
  await db.$transaction(async (tx) => {
    await tx.accessRequest.update({
      where: { id: request.id },
      data: {
        status: approve ? "approved" : "declined",
        decidedById: actor.uid,
        decidedAt: new Date(),
      },
    });
    if (approve) {
      await tx.experimentMember.upsert({
        where: {
          experimentId_userId: {
            experimentId: request.experimentId,
            userId: request.requesterId,
          },
        },
        create: {
          experimentId: request.experimentId,
          userId: request.requesterId,
        },
        update: {},
      });
    }
    const [decider, experiment] = await Promise.all([
      tx.user.findUniqueOrThrow({
        where: { id: actor.uid },
        select: { name: true },
      }),
      tx.experiment.findUniqueOrThrow({
        where: { id: request.experimentId },
        select: { code: true, title: true },
      }),
    ]);
    await notify(tx, {
      organizationId: actor.org,
      userId: request.requesterId,
      actorUserId: actor.uid,
      kind: approve ? "access_approved" : "access_declined",
      actorName: decider.name,
      entityLabel: `${experiment.code} · ${experiment.title}`,
      href: `/experiments/${request.experimentId}`,
    });
    await recordUserAudit(tx, {
      actor,
      action: approve
        ? "experiment.access_granted"
        : "experiment.access_declined",
      entityType: "Experiment",
      entityId: request.experimentId,
      changes: { requesterId: request.requesterId },
    });
  });
}
