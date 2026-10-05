import type { Prisma } from "@prisma/client";
import { serialsFor, shortCodeFor } from "@/lib/instruments/serial";
import { canonicalSerialKey } from "@/lib/instruments/normalize";

// Every caller must supply an interactive transaction. The organization row
// lock serializes allocation; reservation keys provide database uniqueness.
export type SampleSerialClient = Prisma.TransactionClient;

export function experimentLetters(n: number): string {
  let result = "";
  while (n > 0) {
    n -= 1;
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26);
  }
  return result;
}

/** Reserve simulator-shaped aliases too; removing one never frees its name. */
export async function reserveInstrumentCodes(
  client: SampleSerialClient,
  organizationId: string,
  codes: string[],
): Promise<void> {
  const keys = new Set<string>();
  for (const code of codes) {
    const match = canonicalSerialKey(code).match(/^(\d+[A-Z]+)(\d+)(?:-|$)/);
    if (!match) continue;
    keys.add(`PREFIX:${match[1]}`);
    keys.add(`SAMPLE:${match[1]}${match[2]}`);
  }
  if (keys.size) {
    await client.sampleCodeReservation.createMany({
      data: [...keys].map((key) => ({ organizationId, key })),
      skipDuplicates: true,
    });
  }
}

/** Immutable per-organization short handle, protected by the caller's org lock. */
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

async function ensureSimCodePrefix(
  client: SampleSerialClient,
  experimentId: string,
): Promise<string> {
  const experiment = await client.experiment.findUniqueOrThrow({
    where: { id: experimentId },
    select: {
      organizationId: true,
      simCodePrefix: true,
      assigneeId: true,
      createdById: true,
    },
  });
  if (experiment.simCodePrefix) return experiment.simCodePrefix;
  const owner = await client.user.findUniqueOrThrow({
    where: { id: experiment.assigneeId ?? experiment.createdById },
    select: { userNumber: true },
  });
  // No modulo: employee 123 must never share the namespace of employee 23.
  const employee = String(owner.userNumber).padStart(2, "0");
  const used = new Set(
    (
      await client.sampleCodeReservation.findMany({
        where: {
          organizationId: experiment.organizationId,
          key: { startsWith: "PREFIX:" },
        },
        select: { key: true },
      })
    ).map((row) => row.key),
  );
  for (let n = 1; ; n += 1) {
    const letter = experimentLetters(n);
    const prefix = employee + letter;
    const key = `PREFIX:${canonicalSerialKey(prefix)}`;
    if (used.has(key)) continue;
    await client.sampleCodeReservation.create({
      data: { organizationId: experiment.organizationId, key, experimentId },
    });
    await client.experiment.update({
      where: { id: experimentId },
      data: { simCodePrefix: prefix, codeLetter: letter },
    });
    return prefix;
  }
}

/** Issue missing codes once; preserve every existing code and serial alias. */
export async function syncSampleSerials(
  client: SampleSerialClient,
  experimentId: string,
): Promise<void> {
  const experiment = await client.experiment.findUniqueOrThrow({
    where: { id: experimentId },
    select: { organizationId: true },
  });
  await client.organization.update({
    where: { id: experiment.organizationId },
    data: { nextShortNo: { increment: 0 } },
  });
  const shortCode = await ensureShortCode(client, experimentId);
  const samples = await client.sample.findMany({
    where: { experimentId },
    select: { id: true, code: true, simCode: true, instrumentCodes: true },
  });
  // Reserve aliases introduced by legacy imports before allocating anything.
  await reserveInstrumentCodes(
    client,
    experiment.organizationId,
    samples.flatMap((s) => [s.simCode ?? "", ...s.instrumentCodes]),
  );
  let prefix: string | undefined;
  for (const sample of samples) {
    let simCode = sample.simCode;
    const number = /^S([0-9]+)$/i.exec(sample.code)?.[1];
    if (
      !simCode &&
      number &&
      Number.isSafeInteger(Number(number)) &&
      Number(number) >= 1
    ) {
      prefix ??= await ensureSimCodePrefix(client, experimentId);
      simCode = prefix + String(Number(number)).padStart(2, "0");
      const key = `SAMPLE:${canonicalSerialKey(simCode)}`;
      const previous = await client.sampleCodeReservation.findUnique({
        where: {
          organizationId_key: {
            organizationId: experiment.organizationId,
            key,
          },
        },
      });
      if (previous) {
        throw new Error(
          `Sample code ${simCode} was already issued. Keep the existing sample or use a new sample number.`,
        );
      }
      await client.sampleCodeReservation.create({
        data: {
          organizationId: experiment.organizationId,
          key,
          experimentId,
          sampleCode: sample.code,
        },
      });
    }
    const next = serialsFor(shortCode, sample.code, [
      ...sample.instrumentCodes,
      ...(simCode ? [simCode] : []),
    ]);
    if (
      simCode !== sample.simCode ||
      next.length !== sample.instrumentCodes.length ||
      next.some((code, index) => code !== sample.instrumentCodes[index])
    ) {
      await client.sample.update({
        where: { id: sample.id },
        data: { simCode, instrumentCodes: next },
      });
    }
  }
}
