import type { Prisma } from "@prisma/client";
import type { Actor } from "./actor";

export function experimentVisibilityScope(
  actor: Actor,
  includeTest = false,
): Prisma.ExperimentWhereInput {
  const base: Prisma.ExperimentWhereInput = includeTest
    ? { organizationId: actor.org }
    : { organizationId: actor.org, isTest: false };

  if (actor.role === "ADMIN") return base;
  if (actor.role === "MANAGER") {
    return {
      ...base,
      OR: [
        { createdById: actor.uid },
        { members: { some: { userId: actor.uid } } },
      ],
    };
  }
  return { ...base, members: { some: { userId: actor.uid } } };
}
