import "server-only";

import type { Prisma } from "@prisma/client";
import type { Actor } from "@/modules/authorization/actor";

/** This narrow capability does not grant capture or general experiment access. */
export async function canSetTestingStatus(
  client: Prisma.TransactionClient,
  actor: Actor,
): Promise<boolean> {
  return (
    (await client.user.count({
      where: {
        id: actor.uid,
        organizationId: actor.org,
        organization: { status: "ACTIVE" },
        active: true,
        pendingApproval: false,
        mustChangePassword: false,
        testingOnly: true,
      },
    })) === 1
  );
}
