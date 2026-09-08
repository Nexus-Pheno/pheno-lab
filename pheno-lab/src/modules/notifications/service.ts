import "server-only";

import type { Prisma } from "@prisma/client";
import { db } from "@/infrastructure/db/client";
import type { Actor } from "@/modules/authorization/actor";

// In-app notifications: the bell in the header. Rows are written inside the
// emitting service's transaction (pass its client), so a rolled-back action
// never leaves a ghost notification. Text is rendered client-side from
// `kind` + the display fields, so each reader sees their own language.

export type NotificationKind =
  | "access_requested"
  | "access_approved"
  | "access_declined"
  | "feedback_approved"
  | "feedback_rejected"
  | "feedback_implemented"
  | "feedback_commented"
  | "feedback_verified"
  | "feedback_reopened"
  | "assigned"
  | "member_added"
  | "experiment_commented"
  | "mentioned"
  | "material_edit_requested"
  | "material_edit_approved"
  | "material_edit_rejected"
  | "recipe_approval_requested"
  | "recipe_approved"
  | "recipe_rejected";

type DbClient = Prisma.TransactionClient | typeof db;

/** Write one notification. Never notifies someone about their own action. */
export async function notify(
  client: DbClient,
  input: {
    organizationId: string;
    userId: string;
    actorUserId: string;
    kind: NotificationKind;
    actorName: string;
    entityLabel: string;
    href: string;
  },
): Promise<void> {
  if (input.userId === input.actorUserId) return;
  await client.notification.create({
    data: {
      organizationId: input.organizationId,
      userId: input.userId,
      kind: input.kind,
      actorName: input.actorName,
      entityLabel: input.entityLabel.slice(0, 200),
      href: input.href,
    },
  });
}

export type NotificationRow = {
  id: string;
  kind: string;
  actorName: string;
  entityLabel: string;
  href: string;
  unread: boolean;
  createdAt: string;
};

/**
 * The recipient's latest notifications. Opening the panel is reading them:
 * everything returned is marked read, but the rows still carry the unread
 * flag they had, so the panel can highlight what is new.
 */
export async function listNotifications(
  actor: Actor,
): Promise<NotificationRow[]> {
  const rows = await db.notification.findMany({
    where: { userId: actor.uid, organizationId: actor.org },
    orderBy: { createdAt: "desc" },
    take: 30,
    select: {
      id: true,
      kind: true,
      actorName: true,
      entityLabel: true,
      href: true,
      readAt: true,
      createdAt: true,
    },
  });
  const unreadIds = rows.filter((r) => !r.readAt).map((r) => r.id);
  if (unreadIds.length) {
    await db.notification.updateMany({
      where: { id: { in: unreadIds }, userId: actor.uid },
      data: { readAt: new Date() },
    });
  }
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    actorName: r.actorName,
    entityLabel: r.entityLabel,
    href: r.href,
    unread: !r.readAt,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function unreadNotificationCount(actor: Actor): Promise<number> {
  return db.notification.count({
    where: { userId: actor.uid, organizationId: actor.org, readAt: null },
  });
}
