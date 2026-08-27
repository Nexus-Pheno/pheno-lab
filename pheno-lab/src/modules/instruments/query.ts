import "server-only";

import { db } from "@/infrastructure/db/client";
import type { Actor } from "@/modules/authorization/actor";
import { isStaff } from "@/modules/authorization/policy";
import { measurementVisibilityScope } from "@/modules/authorization/scope";
import { toJvFileRow } from "./measurement-service";

const ROW_SELECT = {
  id: true,
  serial: true,
  direction: true,
  operator: true,
  assignedTo: { select: { id: true, name: true } },
  measuredAt: true,
  metrics: true,
  status: true,
  matchNote: true,
  imagePath: true,
  instrument: { select: { name: true } },
  sample: { select: { code: true } },
} as const;

function describeLastSeen(value: Date | null): string | null {
  if (!value) return null;
  const minutes = Math.round((Date.now() - value.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export async function getInstrumentsPageData(actor: Actor) {
  const [instruments, matched, unmatched, experiments, people] =
    await Promise.all([
      db.instrument.findMany({
        where: { organizationId: actor.org },
        orderBy: { name: "asc" },
        include: { _count: { select: { uploads: true, measurements: true } } },
      }),
      db.jvMeasurement.findMany({
        // Scoped, not organization-wide: a scan attached to someone else's
        // experiment must not be readable here by someone who cannot open it.
        where: {
          AND: [measurementVisibilityScope(actor), { status: "MATCHED" }],
        },
        select: ROW_SELECT,
        orderBy: { measuredAt: "desc" },
        take: 100,
      }),
      db.jvMeasurement.findMany({
        where: {
          AND: [measurementVisibilityScope(actor), { status: "UNMATCHED" }],
        },
        select: ROW_SELECT,
        orderBy: { createdAt: "desc" },
        take: 200,
      }),
      db.experiment.findMany({
        where: {
          isTest: false,
          organizationId: actor.org,
          status: { in: ["DRAFT", "IN_LAB", "REVIEW"] },
        },
        select: { code: true, samples: { select: { id: true, code: true } } },
        orderBy: { createdAt: "desc" },
        take: 40,
      }),
      // Who a manager may hand unexplained scans to. Only staff need this list,
      // and only active accounts can receive work.
      isStaff(actor)
        ? db.user.findMany({
            where: { organizationId: actor.org, active: true },
            select: { id: true, name: true },
            orderBy: { name: "asc" },
          })
        : Promise.resolve([]),
    ]);
  return {
    rigs: instruments.map((instrument) => ({
      id: instrument.id,
      name: instrument.name,
      kind: instrument.kind,
      hostname: instrument.hostname,
      agentVersion: instrument.agentVersion,
      watchDirs: instrument.watchDirs,
      lastSeenLabel: describeLastSeen(instrument.lastSeenAt),
      fresh:
        instrument.lastSeenAt !== null &&
        Date.now() - instrument.lastSeenAt.getTime() < 10 * 60 * 1_000,
      lastError: instrument.lastError,
      uploads: instrument._count.uploads,
      measurements: instrument._count.measurements,
    })),
    matched: matched.map(toJvFileRow),
    unmatched: unmatched.map(toJvFileRow),
    people,
    samples: experiments.flatMap((experiment) =>
      experiment.samples
        .sort((left, right) =>
          left.code.localeCompare(right.code, undefined, { numeric: true }),
        )
        .map((sample) => ({
          id: sample.id,
          label: `${experiment.code}-${sample.code}`,
        })),
    ),
  };
}
