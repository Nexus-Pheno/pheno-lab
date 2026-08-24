import "server-only";

import { Prisma, type PrismaClient } from "@prisma/client";
import type { Actor } from "@/modules/authorization/actor";
import { sanitizeAuditValue } from "./sanitize";

type AuditClient = Pick<PrismaClient, "auditEvent"> | Prisma.TransactionClient;

type UserAuditInput = {
  actor: Actor;
  action: string;
  entityType: string;
  entityId: string;
  changes?: unknown;
  metadata?: unknown;
  requestId?: string;
};

type InstrumentAuditInput = {
  organizationId: string;
  instrumentId: string;
  action: string;
  entityType: string;
  entityId: string;
  changes?: unknown;
  metadata?: unknown;
  requestId?: string;
};

type SystemAuditInput = {
  organizationId: string;
  action: string;
  entityType: string;
  entityId: string;
  changes?: unknown;
  metadata?: unknown;
  requestId?: string;
};

export async function recordUserAudit(
  client: AuditClient,
  input: UserAuditInput,
): Promise<void> {
  const changes = sanitizeAuditValue(input.changes);
  const metadata = sanitizeAuditValue(input.metadata);
  await client.auditEvent.create({
    data: {
      organizationId: input.actor.org,
      actorType: "USER",
      actorUserId: input.actor.uid,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      changes: changes === null ? Prisma.JsonNull : changes,
      metadata: metadata === null ? Prisma.JsonNull : metadata,
      requestId: input.requestId,
    },
  });
}

export async function recordInstrumentAudit(
  client: AuditClient,
  input: InstrumentAuditInput,
): Promise<void> {
  const changes = sanitizeAuditValue(input.changes);
  const metadata = sanitizeAuditValue(input.metadata);
  await client.auditEvent.create({
    data: {
      organizationId: input.organizationId,
      actorType: "INSTRUMENT",
      instrumentId: input.instrumentId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      changes: changes === null ? Prisma.JsonNull : changes,
      metadata: metadata === null ? Prisma.JsonNull : metadata,
      requestId: input.requestId,
    },
  });
}

export async function recordSystemAudit(
  client: AuditClient,
  input: SystemAuditInput,
): Promise<void> {
  const changes = sanitizeAuditValue(input.changes);
  const metadata = sanitizeAuditValue(input.metadata);
  await client.auditEvent.create({
    data: {
      organizationId: input.organizationId,
      actorType: "SYSTEM",
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      changes: changes === null ? Prisma.JsonNull : changes,
      metadata: metadata === null ? Prisma.JsonNull : metadata,
      requestId: input.requestId,
    },
  });
}
