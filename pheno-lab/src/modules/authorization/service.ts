import "server-only";

import { db } from "@/infrastructure/db/client";
import type { Actor } from "./actor";
import {
  assertExperimentPermission,
  type ExperimentPermission,
} from "./policy";

export async function requireExperimentPermission(
  actor: Actor,
  experimentId: string,
  permission: ExperimentPermission,
): Promise<void> {
  const resource = await db.experiment.findUniqueOrThrow({
    where: { id: experimentId },
    select: {
      organizationId: true,
      createdById: true,
      assigneeId: true,
      deletedAt: true,
      members: { select: { userId: true } },
    },
  });
  // A trashed experiment is dead to every normal write and read path — only
  // the trash service (which checks permissions itself) may touch it.
  if (resource.deletedAt !== null)
    throw new Error("Experiment is in the recycle bin.");
  assertExperimentPermission(actor, resource, permission);
}
