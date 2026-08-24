import "server-only";

import { db as prisma } from "@/infrastructure/db/client";
import { normalizeSerial } from "@/lib/instruments/normalize";
import type { JvMetrics } from "@/lib/instruments/types";

export { normalizeSerial } from "@/lib/instruments/normalize";

/**
 * Serials are typed by hand on the instrument, so normalize hard before
 * matching: full-width characters (the lab PCs run a Chinese IME), stray
 * spaces/underscores and doubled separators all appear in practice.
 */
/** Experiment codes are YYYY-ORG-USER-SEQ, e.g. 2026-001-1-4. */
const EXPERIMENT_CODE = /^(\d{4}-\d{1,4}-\d+-\d+)/;

export type MatchResult = {
  status: "MATCHED" | "UNMATCHED";
  experimentId: string | null;
  sampleId: string | null;
  runId: string | null;
  matchNote: string;
};

const unmatched = (matchNote: string): MatchResult => ({
  status: "UNMATCHED",
  experimentId: null,
  sampleId: null,
  runId: null,
  matchNote,
});

/**
 * Fallback for labs that keep their own serial scheme ("CELL17-5-2") instead of
 * typing the Pheno sample ID: a sample can declare the serial base it answers
 * to. Only whole segments count as a boundary, so CELL17 must not swallow
 * CELL171 — a real collision in the 2026-04-08 data.
 */
async function matchByInstrumentCode(
  organizationId: string,
  serial: string,
  key: string,
): Promise<MatchResult> {
  // Candidate bases, longest first: E7-S5-2, E7-S5, E7.
  const parts = key.split("-");
  const candidates = parts.map((_, i) =>
    parts.slice(0, parts.length - i).join("-"),
  );

  const samples = await prisma.sample.findMany({
    where: {
      instrumentCodes: { hasSome: candidates },
      experiment: { organizationId },
    },
    select: {
      id: true,
      code: true,
      instrumentCodes: true,
      experimentId: true,
      experiment: {
        select: {
          code: true,
          runs: { select: { id: true }, orderBy: { runNo: "desc" }, take: 1 },
        },
      },
    },
  });
  if (!samples.length) {
    return unmatched(
      `"${serial}" is not an experiment code (e.g. 2026-001-1-4-S1) and no sample answers to it.`,
    );
  }

  for (const candidate of candidates) {
    const hits = samples.filter((s) => s.instrumentCodes.includes(candidate));
    if (!hits.length) continue;
    if (hits.length > 1) {
      const where = hits
        .map((h) => `${h.experiment.code}-${h.code}`)
        .join(", ");
      return unmatched(
        `"${serial}" is claimed by more than one sample (${where}); remove the duplicate serial.`,
      );
    }
    const hit = hits[0];
    const pixel = key.slice(candidate.length).replace(/^-/, "");
    return {
      status: "MATCHED",
      experimentId: hit.experimentId,
      sampleId: hit.id,
      runId: hit.experiment.runs[0]?.id ?? null,
      matchNote:
        `Matched on serial "${candidate}"` +
        (pixel ? ` · pixel ${pixel} — recorded at sample level.` : "."),
    };
  }
  return unmatched(
    `"${serial}" does not match any sample's instrument serial.`,
  );
}

/**
 * Resolve "2026-001-1-4-S1" (or "…-S1-2", a second pixel on the same sample) to
 * the experiment + sample it belongs to. Pixels are not modelled separately —
 * the lab reports one number per sample — so any pixel suffix is recorded in the
 * note and otherwise ignored.
 */
export async function matchSerial(
  organizationId: string,
  serial: string,
): Promise<MatchResult> {
  const key = normalizeSerial(serial);
  if (!key) return unmatched("Empty serial.");

  const codeMatch = key.match(EXPERIMENT_CODE);
  if (!codeMatch) return matchByInstrumentCode(organizationId, serial, key);
  const code = codeMatch[1];

  const experiment = await prisma.experiment.findFirst({
    where: { organizationId, code },
    select: {
      id: true,
      samples: { select: { id: true, code: true } },
      runs: {
        select: { id: true, runNo: true },
        orderBy: { runNo: "desc" },
        take: 1,
      },
    },
  });
  if (!experiment)
    return unmatched(`No experiment ${code} in this organization.`);

  const runId = experiment.runs[0]?.id ?? null;
  const rest = key.slice(code.length).replace(/^-/, "");

  if (!rest) {
    // A bare experiment code is only unambiguous for a single-sample experiment.
    if (experiment.samples.length === 1) {
      return {
        status: "MATCHED",
        experimentId: experiment.id,
        sampleId: experiment.samples[0].id,
        runId,
        matchNote: `Serial had no sample code; ${code} has only one sample.`,
      };
    }
    return unmatched(
      `"${serial}" names experiment ${code} but no sample (e.g. -S1).`,
    );
  }

  const [sampleCode, ...pixelParts] = rest.split("-");
  const sample = experiment.samples.find(
    (s) => s.code.toUpperCase() === sampleCode,
  );
  if (!sample) {
    const known = experiment.samples.map((s) => s.code).join(", ") || "none";
    return unmatched(
      `Experiment ${code} has no sample "${sampleCode}" (has: ${known}).`,
    );
  }

  return {
    status: "MATCHED",
    experimentId: experiment.id,
    sampleId: sample.id,
    runId,
    matchNote: pixelParts.length
      ? `Pixel ${pixelParts.join("-")} — recorded at sample level.`
      : "",
  };
}

// The capture portal stores metrics as labelled strings; auto-filled rows must
// use the very same labels or they will not line up in the results and report
// pages. See METRIC_HINTS in CaptureView.
const METRIC_LABELS = {
  pce: "PCE (%)",
  voc: "Voc (V)",
  jsc: "Jsc (mA/cm²)",
  ff: "FF (%)",
} as const;

const DECIMALS: Record<keyof typeof METRIC_LABELS, number> = {
  pce: 2,
  voc: 4,
  jsc: 2,
  ff: 2,
};

export function metricsToResult(m: JvMetrics): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(
    METRIC_LABELS,
  ) as (keyof typeof METRIC_LABELS)[]) {
    const v = m[key];
    if (typeof v === "number" && Number.isFinite(v))
      out[METRIC_LABELS[key]] = v.toFixed(DECIMALS[key]);
  }
  return out;
}

/** The J-V characterization card of an experiment, if the designer has one. */
async function findJvCharacterization(
  experimentId: string,
): Promise<string | null> {
  const cards = await prisma.characterization.findMany({
    where: { experimentId },
    select: {
      id: true,
      name: true,
      position: true,
      process: { select: { name: true } },
    },
    orderBy: { position: "asc" },
  });
  const isJv = (s: string) =>
    /j-?v|i-?v|current[-\s]?voltage|solar|效率|光电/i.test(s);
  const hit = cards.find((c) => isJv(c.name) || isJv(c.process?.name ?? ""));
  return hit?.id ?? null;
}

/**
 * Re-derive a sample's J-V result from its measurements. The lab does not
 * differentiate pixels — the technician reports the best one — so the sample
 * result is the highest-PCE scan. A result a human typed in the capture portal
 * is never overwritten.
 */
export async function refreshSampleJvResult(
  sampleId: string,
): Promise<"written" | "kept-manual" | "no-card" | "no-data"> {
  const measurements = await prisma.jvMeasurement.findMany({
    where: { sampleId, status: "MATCHED" },
    select: {
      id: true,
      serial: true,
      direction: true,
      metrics: true,
      measuredAt: true,
      runId: true,
      experimentId: true,
      instrument: { select: { name: true } },
    },
  });

  const scored = measurements
    .map((m) => ({ m, pce: Number((m.metrics as JvMetrics)?.pce) }))
    .filter((x) => Number.isFinite(x.pce));
  if (!scored.length) return "no-data";

  scored.sort((a, b) => b.pce - a.pce);
  const best = scored[0].m;
  if (!best.experimentId) return "no-data";

  const characterizationId = await findJvCharacterization(best.experimentId);
  if (!characterizationId) return "no-card";

  const existing = await prisma.characterizationResult.findFirst({
    where: { characterizationId, sampleId, runId: best.runId },
    select: { id: true, source: true, metrics: true },
  });
  if (
    existing &&
    existing.source === "MANUAL" &&
    Object.keys(existing.metrics ?? {}).length > 0
  ) {
    return "kept-manual";
  }

  const scanCount = measurements.length;
  const note =
    `Auto-filled from ${best.instrument.name}: best of ${scanCount} scan${scanCount === 1 ? "" : "s"} ` +
    `(${best.serial}${best.direction ? `, ${best.direction.toLowerCase()}` : ""}).`;
  const data = {
    metrics: metricsToResult(best.metrics as JvMetrics),
    note,
    source: "INSTRUMENT",
    sourceMeasurementId: best.id,
    capturedAt: best.measuredAt ?? new Date(),
  };

  if (existing) {
    await prisma.characterizationResult.update({
      where: { id: existing.id },
      data,
    });
  } else {
    await prisma.characterizationResult.create({
      data: { ...data, characterizationId, sampleId, runId: best.runId },
    });
  }
  return "written";
}
