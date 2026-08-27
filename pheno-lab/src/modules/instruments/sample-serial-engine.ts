import type { PrismaClient } from "@prisma/client";
import { serialsFor, shortCodeFor } from "@/lib/instruments/serial";
import { normalizeSerial } from "@/lib/instruments/normalize";

export type SampleSerialClient = Pick<
  PrismaClient,
  "experiment" | "organization" | "sample" | "user"
>;

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Assign an immutable per-organization short code the first time it is needed. */
export async function ensureShortCode(
  client: SampleSerialClient,
  experimentId: string,
): Promise<string> {
  const experiment = await client.experiment.findUniqueOrThrow({
    where: { id: experimentId },
    select: { shortCode: true, organizationId: true },
  });
  if (experiment.shortCode) return experiment.shortCode;

  const organization = await client.organization.update({
    where: { id: experiment.organizationId },
    data: { nextShortNo: { increment: 1 } },
    select: { nextShortNo: true },
  });
  const shortCode = shortCodeFor(organization.nextShortNo - 1);
  await client.experiment.update({
    where: { id: experimentId },
    data: { shortCode },
  });
  return shortCode;
}

/**
 * The 3-char prefix of this experiment's solar-simulator codes:
 * 2-digit employee number of the responsible person (assignee, falling back
 * to the creator) plus a letter that is unique among that person's other
 * in-flight experiments — so 01A05 and 01B05 never collide even when one
 * technician runs two experiments at once.
 */
async function ensureSimCodePrefix(
  client: SampleSerialClient,
  experimentId: string,
): Promise<string | null> {
  const experiment = await client.experiment.findUniqueOrThrow({
    where: { id: experimentId },
    select: {
      organizationId: true,
      codeLetter: true,
      assigneeId: true,
      createdById: true,
    },
  });
  const ownerId = experiment.assigneeId ?? experiment.createdById;
  const owner = await client.user.findUnique({
    where: { id: ownerId },
    select: { userNumber: true },
  });
  if (!owner) return null;
  const employee = String(owner.userNumber % 100).padStart(2, "0");

  const others = await client.experiment.findMany({
    where: {
      organizationId: experiment.organizationId,
      id: { not: experimentId },
      codeLetter: { not: null },
      status: { notIn: ["COMPLETE", "ARCHIVED"] },
      OR: [{ assigneeId: ownerId }, { assigneeId: null, createdById: ownerId }],
    },
    select: { codeLetter: true },
  });
  const used = new Set(others.map((o) => o.codeLetter));
  let letter = experiment.codeLetter;
  if (!letter || used.has(letter)) {
    letter = [...LETTERS].find((l) => !used.has(l)) ?? "Z";
    await client.experiment.update({
      where: { id: experimentId },
      data: { codeLetter: letter },
    });
  }
  return employee + letter;
}

/** Recompute derived serials and sim codes while retaining lab aliases. */
export async function syncSampleSerials(
  client: SampleSerialClient,
  experimentId: string,
): Promise<void> {
  const shortCode = await ensureShortCode(client, experimentId);
  const prefix = await ensureSimCodePrefix(client, experimentId);
  const samples = await client.sample.findMany({
    where: { experimentId },
    select: { id: true, code: true, simCode: true, instrumentCodes: true },
  });
  for (const sample of samples) {
    const number = Number.parseInt(sample.code.replace(/\D/g, ""), 10);
    const simCode =
      prefix && Number.isFinite(number) && number >= 1 && number <= 99
        ? `${prefix}${String(number).padStart(2, "0")}`
        : null;

    const derived = new Set(
      [
        serialsFor(shortCode, sample.code)[0],
        sample.simCode ? normalizeSerial(sample.simCode) : "",
        simCode ? normalizeSerial(simCode) : "",
      ].filter(Boolean),
    );
    const aliases = sample.instrumentCodes.filter((code) => !derived.has(code));
    const next = serialsFor(shortCode, sample.code, aliases);
    if (simCode) {
      const key = normalizeSerial(simCode);
      if (key && !next.includes(key)) next.push(key);
    }
    const same =
      simCode === sample.simCode &&
      next.length === sample.instrumentCodes.length &&
      next.every((code, index) => code === sample.instrumentCodes[index]);
    if (!same) {
      await client.sample.update({
        where: { id: sample.id },
        data: { simCode, instrumentCodes: next },
      });
    }
  }
}
