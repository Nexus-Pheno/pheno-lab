import type { Actor, ExperimentAccessResource } from "./actor";

export type ExperimentPermission = "read" | "manage" | "capture" | "submit";

export class AuthorizationError extends Error {
  constructor(message = "You are not allowed to perform this action.") {
    super(message);
    this.name = "AuthorizationError";
  }
}

export function isStaff(actor: Actor): boolean {
  return actor.role === "ADMIN" || actor.role === "MANAGER";
}

export function assertStaff(actor: Actor): void {
  if (!isStaff(actor)) {
    throw new AuthorizationError("Managers or admins only.");
  }
}

export function assertAdmin(actor: Actor): void {
  if (actor.role !== "ADMIN") {
    throw new AuthorizationError("Only the organization admin can do this.");
  }
}

function sameOrganization(
  actor: Actor,
  resource: ExperimentAccessResource,
): boolean {
  return actor.org === resource.organizationId;
}

function isCreatorOrMember(
  actor: Actor,
  resource: ExperimentAccessResource,
): boolean {
  return (
    resource.createdById === actor.uid ||
    resource.members.some((member) => member.userId === actor.uid)
  );
}

function isInvolved(actor: Actor, resource: ExperimentAccessResource): boolean {
  return (
    resource.assigneeId === actor.uid || isCreatorOrMember(actor, resource)
  );
}

// Michael's model (2026-09-07): every experiment is LISTED to the whole lab,
// but opening one is gated — technicians open only experiments they created,
// are assigned to, or were granted membership of (via an access request the
// owner approved); managers and admins open everything.
export function canReadExperiment(
  actor: Actor,
  resource: ExperimentAccessResource,
): boolean {
  if (!sameOrganization(actor, resource)) return false;
  if (isStaff(actor)) return true;
  return isInvolved(actor, resource);
}

// Managers edit every experiment in the lab; technicians edit the ones they
// created. Granted membership means collaborate (read + capture), not
// redesign — the owner keeps the pen on the test plan.
export function canManageExperiment(
  actor: Actor,
  resource: ExperimentAccessResource,
): boolean {
  if (!sameOrganization(actor, resource)) return false;
  if (isStaff(actor)) return true;
  return resource.createdById === actor.uid;
}

export function canCaptureExperiment(
  actor: Actor,
  resource: ExperimentAccessResource,
): boolean {
  if (!sameOrganization(actor, resource)) return false;
  return isStaff(actor) || isInvolved(actor, resource);
}

export function canSubmitExperiment(
  actor: Actor,
  resource: ExperimentAccessResource,
): boolean {
  if (!sameOrganization(actor, resource)) return false;
  return isStaff(actor) || isInvolved(actor, resource);
}

export function assertExperimentPermission(
  actor: Actor,
  resource: ExperimentAccessResource,
  permission: ExperimentPermission,
): void {
  const allowed =
    permission === "read"
      ? canReadExperiment(actor, resource)
      : permission === "manage"
        ? canManageExperiment(actor, resource)
        : permission === "capture"
          ? canCaptureExperiment(actor, resource)
          : canSubmitExperiment(actor, resource);

  if (!allowed) {
    throw new AuthorizationError(
      sameOrganization(actor, resource)
        ? "You do not have access to this experiment."
        : "Experiment belongs to another organization.",
    );
  }
}
