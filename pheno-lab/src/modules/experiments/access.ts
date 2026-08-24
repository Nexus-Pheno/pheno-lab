import "server-only";

import type { Prisma } from "@prisma/client";
import { db } from "@/infrastructure/db/client";
import type { Actor } from "@/modules/authorization/actor";
import { assertStaff } from "@/modules/authorization/policy";
import { experimentVisibilityScope } from "@/modules/authorization/scope";
import { requireExperimentPermission } from "@/modules/authorization/service";

/**
 * Test runs are excluded from normal views by construction. The test-data
 * surface opts in explicitly.
 */
export function canViewWhere(
  actor: Actor,
  includeTest = false,
): Prisma.ExperimentWhereInput {
  return experimentVisibilityScope(actor, includeTest);
}

export async function assertEdit(
  actor: Actor,
  experimentId: string,
): Promise<void> {
  assertStaff(actor);
  await requireExperimentPermission(actor, experimentId, "manage");
}

export async function assertEditByStep(actor: Actor, stepId: string) {
  const step = await db.processStep.findUniqueOrThrow({
    where: { id: stepId },
    select: { experimentId: true, processId: true },
  });
  await assertEdit(actor, step.experimentId);
  return step;
}

export async function assertEditByChar(actor: Actor, charId: string) {
  const characterization = await db.characterization.findUniqueOrThrow({
    where: { id: charId },
    select: { experimentId: true, processId: true },
  });
  await assertEdit(actor, characterization.experimentId);
  return characterization;
}
