import "server-only";
import type { Prisma } from "@prisma/client";

/** Serialize catalogue names with private SAM saves/imports in the same organization. */
export async function lockMaterialCatalogue(
  tx: Prisma.TransactionClient,
  organizationId: string,
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`chemical-save:${organizationId}`},0))`;
}
