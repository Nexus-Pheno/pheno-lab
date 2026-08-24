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
      members: { select: { userId: true } },
    },
  });
  assertExperimentPermission(actor, resource, permission);
}
