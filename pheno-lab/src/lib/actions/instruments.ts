"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireSession, type Session } from "@/lib/auth";
import { matchSerial, refreshSampleJvResult } from "@/lib/instruments/match";
import { rematchMeasurements, type RematchSummary } from "@/lib/instruments/rematch";
import { sampleSerial, serialsFor } from "@/lib/instruments/serial";

// Same rule as capture: members of an experiment (any role) and org admins may
// pull instrument files into it.
async function assertCapture(experimentId: string): Promise<Session> {
  const session = await requireSession();
  const exp = await db.experiment.findUniqueOrThrow({
    where: { id: experimentId },
    select: { organizationId: true, createdById: true, members: { select: { userId: true } } },
  });
  if (exp.organizationId !== session.org) throw new Error("Experiment belongs to another organization.");
  if (session.role === "ADMIN") return session;
  if (exp.createdById === session.uid || exp.members.some((m) => m.userId === session.uid)) return session;
  throw new Error("You are not assigned to this experiment.");
}

export type JvFileRow = {
  id: string;
  serial: string;
  sampleCode: string | null;
  direction: string | null;
  instrument: string;
  measuredAt: string | null;
  pce: number | null;
  voc: number | null;
  jsc: number | null;
  ff: number | null;
  status: string;
  matchNote: string;
  imagePath: string | null;
};

const toRow = (m: {
  id: string;
  serial: string;
  direction: string | null;
  measuredAt: Date | null;
  metrics: unknown;
  status: string;
  matchNote: string;
  imagePath: string | null;
  instrument: { name: string };
  sample: { code: string } | null;
}): JvFileRow => {
  const metrics = (m.metrics ?? {}) as Record<string, number | undefined>;
  const n = (v: number | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    id: m.id,
    serial: m.serial,
    sampleCode: m.sample?.code ?? null,
    direction: m.direction,
    instrument: m.instrument.name,
    measuredAt: m.measuredAt ? m.measuredAt.toISOString() : null,
    pce: n(metrics.pce),
    voc: n(metrics.voc),
    jsc: n(metrics.jsc),
    ff: n(metrics.ff),
    status: m.status,
    matchNote: m.matchNote,
    imagePath: m.imagePath,
  };
};

const ROW_SELECT = {
  id: true,
  serial: true,
  direction: true,
  measuredAt: true,
  metrics: true,
  status: true,
  matchNote: true,
  imagePath: true,
  instrument: { select: { name: true } },
  sample: { select: { code: true } },
} as const;

export type JvPullResult = {
  summary: RematchSummary;
  files: JvFileRow[];
  samples: {
    id: string;
    code: string;
    group: string | null;
    serial: string;
    aliases: string[];
    scans: number;
    pce: number | null;
  }[];
  candidates: JvFileRow[];
};

/**
 * "Pull J-V files" — re-run matching for this experiment, then report what is
 * attached, which samples still have nothing, and which unmatched files look
 * like they might belong here so a mistyped serial can be fixed by hand.
 */
export async function pullJvFiles(experimentId: string): Promise<JvPullResult> {
  const session = await assertCapture(experimentId);
  const exp = await db.experiment.findUniqueOrThrow({
    where: { id: experimentId },
    select: {
      code: true,
      shortCode: true,
      samples: { select: { id: true, code: true, variationGroup: true, instrumentCodes: true } },
    },
  });

  // Either the full code or the short handle may have been typed on the rig.
  const summary = await rematchMeasurements({
    organizationId: session.org,
    serialPrefixes: [exp.code, exp.shortCode ?? ""],
  });

  const [attached, unmatched] = await Promise.all([
    db.jvMeasurement.findMany({
      where: { experimentId },
      select: ROW_SELECT,
      orderBy: [{ measuredAt: "desc" }],
      take: 300,
    }),
    // Anything unmatched from the last month is a plausible mis-typed serial.
    db.jvMeasurement.findMany({
      where: {
        organizationId: session.org,
        status: "UNMATCHED",
        createdAt: { gte: new Date(Date.now() - 30 * 24 * 3600 * 1000) },
      },
      select: ROW_SELECT,
      orderBy: [{ createdAt: "desc" }],
      take: 100,
    }),
  ]);

  const files = attached.map(toRow);
  const bySample = new Map<string, JvFileRow[]>();
  for (const f of files) {
    if (!f.sampleCode) continue;
    const list = bySample.get(f.sampleCode) ?? [];
    list.push(f);
    bySample.set(f.sampleCode, list);
  }

  const samples = exp.samples
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }))
    .map((s) => {
      const scans = bySample.get(s.code) ?? [];
      const best = scans.reduce<number | null>((acc, f) => (f.pce != null && (acc == null || f.pce > acc) ? f.pce : acc), null);
      return {
        id: s.id,
        code: s.code,
        group: s.variationGroup,
        serial: s.instrumentCodes[0] ?? "",
        aliases: s.instrumentCodes.slice(1),
        scans: scans.length,
        pce: best,
      };
    });

  return { summary, files, samples, candidates: unmatched.map(toRow) };
}

/** Attach a measurement to a sample by hand — the fix for a mistyped serial. */
export async function assignMeasurement(measurementId: string, sampleId: string): Promise<void> {
  const measurement = await db.jvMeasurement.findUniqueOrThrow({
    where: { id: measurementId },
    select: { organizationId: true, sampleId: true },
  });
  const sample = await db.sample.findUniqueOrThrow({
    where: { id: sampleId },
    select: { id: true, experimentId: true, experiment: { select: { organizationId: true } } },
  });
  const session = await assertCapture(sample.experimentId);
  if (measurement.organizationId !== session.org || sample.experiment.organizationId !== session.org) {
    throw new Error("That measurement belongs to another organization.");
  }

  const run = await db.run.findFirst({
    where: { experimentId: sample.experimentId },
    orderBy: { runNo: "desc" },
    select: { id: true },
  });

  await db.jvMeasurement.update({
    where: { id: measurementId },
    data: {
      status: "MATCHED",
      sampleId,
      experimentId: sample.experimentId,
      runId: run?.id ?? null,
      matchNote: "Assigned by hand.",
    },
  });

  // The sample it used to be on also has to be recomputed.
  if (measurement.sampleId && measurement.sampleId !== sampleId) await refreshSampleJvResult(measurement.sampleId);
  await refreshSampleJvResult(sampleId);
  revalidatePath(`/experiments/${sample.experimentId}`);
}

/** Detach a measurement — undo a wrong assignment, or hide a junk scan. */
export async function unassignMeasurement(measurementId: string, ignore = false): Promise<void> {
  const measurement = await db.jvMeasurement.findUniqueOrThrow({
    where: { id: measurementId },
    select: { organizationId: true, sampleId: true, experimentId: true, serial: true },
  });
  const session = await requireSession();
  if (measurement.organizationId !== session.org) throw new Error("That measurement belongs to another organization.");
  if (measurement.experimentId) await assertCapture(measurement.experimentId);

  const previous = measurement.sampleId;
  await db.jvMeasurement.update({
    where: { id: measurementId },
    data: {
      status: ignore ? "IGNORED" : "UNMATCHED",
      sampleId: null,
      experimentId: null,
      runId: null,
      matchNote: ignore ? "Ignored by a reviewer." : "Detached by a reviewer.",
    },
  });
  if (previous) await refreshSampleJvResult(previous);
}

/** Org-wide sweep, triggered from the instruments page. */
export async function rematchNow(): Promise<RematchSummary> {
  const session = await requireSession();
  if (session.role === "TECHNICIAN") throw new Error("Not allowed");
  const summary = await rematchMeasurements({ organizationId: session.org });
  revalidatePath("/instruments");
  return summary;
}

/** Re-check one serial without changing anything — used to explain a failure. */
export async function explainSerial(serial: string): Promise<string> {
  const session = await requireSession();
  const result = await matchSerial(session.org, serial);
  return result.status === "MATCHED" ? "Matches." : result.matchNote;
}

/**
 * Adds or removes the extra serials a sample answers to. The app-assigned
 * serial (the first entry) cannot be removed — it is what makes matching
 * survive a test-plan edit.
 */
export async function setSampleAliases(sampleId: string, aliases: string[]): Promise<string[]> {
  const sample = await db.sample.findUniqueOrThrow({
    where: { id: sampleId },
    select: { code: true, experimentId: true, instrumentCodes: true, experiment: { select: { shortCode: true } } },
  });
  await assertCapture(sample.experimentId);

  const primary = sampleSerial(sample.experiment.shortCode ?? "", sample.code);
  const next = serialsFor(sample.experiment.shortCode ?? "", sample.code, aliases);

  // A serial may only ever mean one sample.
  const taken = await db.sample.findMany({
    where: {
      instrumentCodes: { hasSome: next.filter((c) => c !== primary) },
      experiment: { organizationId: (await requireSession()).org },
      NOT: { id: sampleId },
    },
    select: { code: true, experiment: { select: { code: true } } },
  });
  if (taken.length) {
    throw new Error(`Already used by ${taken.map((t) => `${t.experiment.code}-${t.code}`).join(", ")}.`);
  }

  await db.sample.update({ where: { id: sampleId }, data: { instrumentCodes: next } });
  // An alias that now exists may claim files sitting in the unmatched queue.
  await rematchMeasurements({ organizationId: (await requireSession()).org, limit: 200 });
  revalidatePath(`/experiments/${sample.experimentId}`);
  return next;
}
