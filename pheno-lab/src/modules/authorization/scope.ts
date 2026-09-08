import type { Prisma } from "@prisma/client";
import type { Actor } from "./actor";

/**
 * Which experiments an actor may OPEN (contents: plan, results, data, files).
 * Managers and admins open everything in the lab; technicians open what they
 * created, are assigned to, or joined (membership — including via an approved
 * access request). Lists use experimentListScope below instead.
 */
export function experimentVisibilityScope(
  actor: Actor,
  includeTest = false,
): Prisma.ExperimentWhereInput {
  // deletedAt: null everywhere — trashed experiments exist only in the
  // recycle bin, never in a scope.
  const base: Prisma.ExperimentWhereInput = includeTest
    ? { organizationId: actor.org, deletedAt: null }
    : { organizationId: actor.org, isTest: false, deletedAt: null };

  if (actor.role === "ADMIN" || actor.role === "MANAGER") return base;
  return {
    ...base,
    OR: [
      { createdById: actor.uid },
      { assigneeId: actor.uid },
      { members: { some: { userId: actor.uid } } },
    ],
  };
}

/**
 * Which experiments appear on the shared board: all of them, for everyone —
 * the lab works in the open. Only the card metadata shows; opening one still
 * goes through experimentVisibilityScope / canReadExperiment, and a
 * technician clicking someone else's card lands on the request-access page.
 */
export function experimentListScope(
  actor: Actor,
  includeTest = false,
): Prisma.ExperimentWhereInput {
  return includeTest
    ? { organizationId: actor.org, deletedAt: null }
    : { organizationId: actor.org, isTest: false, deletedAt: null };
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
  // Scans of trashed experiments hide with their experiment; unattached
  // scans (experimentId null) are unaffected.
  const liveExperiment: Prisma.JvMeasurementWhereInput = {
    OR: [{ experimentId: null }, { experiment: { deletedAt: null } }],
  };
  const base: Prisma.JvMeasurementWhereInput = {
    organizationId: actor.org,
    AND: [liveExperiment],
  };
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
