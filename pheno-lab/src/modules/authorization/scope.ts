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

/**
 * Which instrument measurements an actor may read.
 *
 * A scan reaches someone by one of three routes, in order:
 *  1. it is attached to a sample — then it follows that experiment's rules, so
 *     it cannot be read by anyone who could not open the experiment itself;
 *  2. it is owned by them, either because the operator name written on the rig
 *     resolved to their account or a manager handed it over;
 *  3. nobody owns it and no sample explains it — an orphan, visible only to
 *     managers and admins so they can triage and pass it on.
 *
 * Before this existed the instruments page filtered on organization alone, so
 * every member of the lab could read every J-V result — including results of
 * experiments they were not on.
 */
export function measurementVisibilityScope(
  actor: Actor,
): Prisma.JvMeasurementWhereInput {
  const base = { organizationId: actor.org };
  if (actor.role === "ADMIN") return base;

  const throughExperiment: Prisma.JvMeasurementWhereInput = {
    experiment: experimentVisibilityScope(actor),
  };
  const ownedByActor: Prisma.JvMeasurementWhereInput = {
    assignedToId: actor.uid,
  };
  // An orphan explains itself to nobody: no sample, no owner.
  const orphan: Prisma.JvMeasurementWhereInput = {
    sampleId: null,
    assignedToId: null,
  };

  return {
    ...base,
    OR:
      actor.role === "MANAGER"
        ? [throughExperiment, ownedByActor, orphan]
        : [throughExperiment, ownedByActor],
  };
}
