import "server-only";
import type { Prisma } from "@prisma/client";

export async function lockPresetCatalogue(
  tx: Prisma.TransactionClient,
  organizationId: string,
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`preset-catalogue:${organizationId}`},0))`;
}
