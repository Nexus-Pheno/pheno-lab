import type { PrismaClient } from "@prisma/client";
import { serialsFor, shortCodeFor } from "@/lib/instruments/serial";

export type SampleSerialClient = Pick<
  PrismaClient,
  "experiment" | "organization" | "sample"
>;

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

/** Recompute derived serials while retaining aliases entered by the lab. */
export async function syncSampleSerials(
  client: SampleSerialClient,
  experimentId: string,
): Promise<void> {
  const shortCode = await ensureShortCode(client, experimentId);
  const samples = await client.sample.findMany({
    where: { experimentId },
    select: { id: true, code: true, instrumentCodes: true },
  });
  for (const sample of samples) {
    const aliases = sample.instrumentCodes.filter(
      (code) => code !== serialsFor(shortCode, sample.code)[0],
    );
    const next = serialsFor(shortCode, sample.code, aliases);
    const same =
      next.length === sample.instrumentCodes.length &&
      next.every((code, index) => code === sample.instrumentCodes[index]);
    if (!same) {
      await client.sample.update({
        where: { id: sample.id },
        data: { instrumentCodes: next },
      });
    }
  }
}
