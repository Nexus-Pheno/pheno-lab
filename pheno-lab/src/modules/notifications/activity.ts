import "server-only";

import { db } from "@/infrastructure/db/client";

// Who worked on which experiments in a window, read from the audit trail.
// Designer edits land on steps, capture lands on runs, so an event on any of
// those is resolved back to its experiment; test experiments and the recycle
// bin do not count, and the nightly housekeeping's own events are not work.

const ENTITY_TYPES = [
  "Experiment",
  "ProcessStep",
  "Run",
  "Characterization",
  "CharacterizationResult",
  "Sample",
] as const;

export async function experimentsTouchedYesterday(
  organizationId: string,
  start: Date,
  end: Date,
): Promise<{ name: string; experiments: number }[]> {
  const events = await db.auditEvent.findMany({
    where: {
      organizationId,
      actorType: "USER",
      actorUserId: { not: null },
      createdAt: { gte: start, lt: end },
      entityType: { in: [...ENTITY_TYPES] },
      NOT: { action: { startsWith: "experiment.idle_" } },
    },
    select: { actorUserId: true, entityType: true, entityId: true },
  });
  if (events.length === 0) return [];

  const idsOf = (type: string) => [
    ...new Set(
      events.filter((e) => e.entityType === type).map((e) => e.entityId),
    ),
  ];
  const [steps, runs, chars, results, samples] = await Promise.all([
    db.processStep.findMany({
      where: { id: { in: idsOf("ProcessStep") } },
      select: { id: true, experimentId: true },
    }),
    db.run.findMany({
      where: { id: { in: idsOf("Run") } },
      select: { id: true, experimentId: true },
    }),
    db.characterization.findMany({
      where: { id: { in: idsOf("Characterization") } },
      select: { id: true, experimentId: true },
    }),
    db.characterizationResult.findMany({
      where: { id: { in: idsOf("CharacterizationResult") } },
      select: {
        id: true,
        characterization: { select: { experimentId: true } },
      },
    }),
    db.sample.findMany({
      where: { id: { in: idsOf("Sample") } },
      select: { id: true, experimentId: true },
    }),
  ]);
  const toExperiment = new Map<string, string>();
  for (const id of idsOf("Experiment"))
    toExperiment.set(`Experiment:${id}`, id);
  for (const r of steps)
    toExperiment.set(`ProcessStep:${r.id}`, r.experimentId);
  for (const r of runs) toExperiment.set(`Run:${r.id}`, r.experimentId);
  for (const r of chars)
    toExperiment.set(`Characterization:${r.id}`, r.experimentId);
  for (const r of results)
    toExperiment.set(
      `CharacterizationResult:${r.id}`,
      r.characterization.experimentId,
    );
  for (const r of samples) toExperiment.set(`Sample:${r.id}`, r.experimentId);

  const candidate = new Set(toExperiment.values());
  const real = new Set(
    (
      await db.experiment.findMany({
        where: {
          id: { in: [...candidate] },
          organizationId,
          isTest: false,
          deletedAt: null,
        },
        select: { id: true },
      })
    ).map((e) => e.id),
  );

  const perUser = new Map<string, Set<string>>();
  for (const e of events) {
    const experimentId = toExperiment.get(`${e.entityType}:${e.entityId}`);
    if (!experimentId || !real.has(experimentId) || !e.actorUserId) continue;
    const set = perUser.get(e.actorUserId) ?? new Set<string>();
    set.add(experimentId);
    perUser.set(e.actorUserId, set);
  }
  if (perUser.size === 0) return [];
  const users = await db.user.findMany({
    where: { id: { in: [...perUser.keys()] }, organizationId },
    select: { id: true, name: true },
  });
  return users
    .map((u) => ({ name: u.name, experiments: perUser.get(u.id)?.size ?? 0 }))
    .filter((r) => r.experiments > 0);
}
