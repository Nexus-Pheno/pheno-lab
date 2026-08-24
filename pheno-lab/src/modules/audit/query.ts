import "server-only";

import { db } from "@/infrastructure/db/client";
import type { Actor } from "@/modules/authorization/actor";
import { assertAdmin } from "@/modules/authorization/policy";

export async function listAuditEvents(
  actor: Actor,
  options: { entityType?: string; entityId?: string; take?: number } = {},
) {
  assertAdmin(actor);
  return db.auditEvent.findMany({
    where: {
      organizationId: actor.org,
      ...(options.entityType ? { entityType: options.entityType } : {}),
      ...(options.entityId ? { entityId: options.entityId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(options.take ?? 100, 1), 500),
  });
}
