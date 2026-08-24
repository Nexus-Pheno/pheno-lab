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
    throw new AuthorizationError("Technicians have read-only access.");
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

export function canReadExperiment(
  actor: Actor,
  resource: ExperimentAccessResource,
): boolean {
  if (!sameOrganization(actor, resource)) return false;
  if (actor.role === "ADMIN") return true;
  if (actor.role === "MANAGER") return isCreatorOrMember(actor, resource);
  return resource.members.some((member) => member.userId === actor.uid);
}

export function canManageExperiment(
  actor: Actor,
  resource: ExperimentAccessResource,
): boolean {
  if (!sameOrganization(actor, resource) || !isStaff(actor)) return false;
  return actor.role === "ADMIN" || isCreatorOrMember(actor, resource);
}

export function canCaptureExperiment(
  actor: Actor,
  resource: ExperimentAccessResource,
): boolean {
  if (!sameOrganization(actor, resource)) return false;
  return actor.role === "ADMIN" || isCreatorOrMember(actor, resource);
}

export function canSubmitExperiment(
  actor: Actor,
  resource: ExperimentAccessResource,
): boolean {
  if (!sameOrganization(actor, resource)) return false;
  return (
    actor.role === "ADMIN" ||
    resource.assigneeId === actor.uid ||
    isCreatorOrMember(actor, resource)
  );
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
