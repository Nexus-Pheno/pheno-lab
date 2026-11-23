import "server-only";
import { db } from "@/infrastructure/db/client";
import type { Actor } from "@/modules/authorization/actor";
import {
  AuthorizationError,
  assertFullAccess,
} from "@/modules/authorization/policy";
export const eligibleStudyAccount = {
  active: true,
  pendingApproval: false,
  testingOnly: false,
  mustChangePassword: false,
  organization: { status: "ACTIVE" },
} as const;
export async function canOpenStudies(
  actor: Actor,
  client: Pick<typeof db, "user"> = db,
) {
  if (
    actor.testingOnly ||
    actor.mustChangePassword ||
    ("device" in actor && actor.device)
  )
    return false;
  return Boolean(
    await client.user.findFirst({
      where: {
        ...eligibleStudyAccount,
        id: actor.uid,
        organizationId: actor.org,
        filmStudyAccess: true,
      },
      select: { id: true },
    }),
  );
}
export async function requireStudies(
  actor: Actor,
  client: Pick<typeof db, "user"> = db,
) {
  assertFullAccess(actor);
  if (!(await canOpenStudies(actor, client))) throw new AuthorizationError();
}
