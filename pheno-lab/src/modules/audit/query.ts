import "server-only";

import { db } from "@/infrastructure/db/client";
import type { Actor } from "@/modules/authorization/actor";
import { assertAdmin } from "@/modules/authorization/policy";

export type ActivityFeed = {
  /** Active teammates seen within the last 5 minutes. */
  online: { id: string; name: string }[];
  events: {
    id: string;
    actorName: string;
    action: string;
    entityType: string;
    /** Human handle for the entity — experiment code, equipment name, … */
    entityLabel: string;
    entityHref: string | null;
    createdAt: string; // ISO
  }[];
};

/**
 * The admin activity monitor: who is online right now, and the most recent
 * audited changes as a readable feed. Read-only over existing audit rows.
 */
export async function getActivityFeed(actor: Actor): Promise<ActivityFeed> {
  assertAdmin(actor);
  const [onlineUsers, events] = await Promise.all([
    db.user.findMany({
      where: {
        organizationId: actor.org,
        active: true,
        lastSeenAt: { gte: new Date(Date.now() - 5 * 60_000) },
      },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    db.auditEvent.findMany({
      where: { organizationId: actor.org, actorUserId: { not: null } },
      orderBy: { createdAt: "desc" },
      take: 40,
      select: {
        id: true,
        actorUserId: true,
        action: true,
        entityType: true,
        entityId: true,
        createdAt: true,
      },
    }),
  ]);

  const idsBy = (type: string) => [
    ...new Set(
      events.filter((e) => e.entityType === type).map((e) => e.entityId),
    ),
  ];
  const [actors, experiments, equipment, materials, ingestItems] =
    await Promise.all([
      db.user.findMany({
        where: { id: { in: [...new Set(events.map((e) => e.actorUserId!))] } },
        select: { id: true, name: true },
      }),
      db.experiment.findMany({
        where: { id: { in: idsBy("Experiment") } },
        select: { id: true, code: true, title: true },
      }),
      db.equipment.findMany({
        where: { id: { in: idsBy("Equipment") } },
        select: { id: true, name: true },
      }),
      db.material.findMany({
        where: { id: { in: idsBy("Material") } },
        select: { id: true, name: true },
      }),
      db.ingestItem.findMany({
        where: { id: { in: idsBy("IngestItem") } },
        select: { id: true, title: true },
      }),
    ]);
  const actorName = new Map(actors.map((u) => [u.id, u.name]));
  const label = new Map<string, { text: string; href: string | null }>();
  for (const e of experiments)
    label.set(`Experiment:${e.id}`, {
      text: `${e.code} ${e.title}`.trim(),
      href: `/experiments/${e.id}`,
    });
  for (const e of equipment)
    label.set(`Equipment:${e.id}`, { text: e.name, href: "/library" });
  for (const m of materials)
    label.set(`Material:${m.id}`, { text: m.name, href: "/library" });
  for (const i of ingestItems)
    label.set(`IngestItem:${i.id}`, { text: i.title, href: "/ingest" });

  return {
    online: onlineUsers,
    events: events.map((e) => {
      const hit = label.get(`${e.entityType}:${e.entityId}`);
      return {
        id: e.id,
        actorName: actorName.get(e.actorUserId!) ?? "?",
        action: e.action,
        entityType: e.entityType,
        entityLabel: hit?.text ?? e.entityType,
        entityHref: hit?.href ?? null,
        createdAt: e.createdAt.toISOString(),
      };
    }),
  };
}

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
