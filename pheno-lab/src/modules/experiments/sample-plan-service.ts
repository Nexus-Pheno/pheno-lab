import "server-only";

import type { Prisma } from "@prisma/client";

/** Reconcile a plan without rebuilding physical samples or their QR identities. */
export async function reconcileSamples(
  tx: Prisma.TransactionClient,
  organizationId: string,
  experimentId: string,
  desired: { code: string; variationGroup: string | null }[],
): Promise<void> {
  // Same lock order as code allocation and alias edits: organization first,
  // then experiment/sample rows. Otherwise a plan edit can deadlock an alias edit.
  await tx.organization.update({
    where: { id: organizationId },
    data: { nextShortNo: { increment: 0 } },
  });
  await tx.$queryRaw`
    SELECT "id" FROM "Experiment"
    WHERE "id" = ${experimentId} AND "organizationId" = ${organizationId}
    FOR UPDATE
  `;
  const experiment = await tx.experiment.findFirstOrThrow({
    where: { id: experimentId, organizationId, deletedAt: null },
    select: { id: true },
  });
  const current = await tx.sample.findMany({
    where: { experimentId: experiment.id },
    include: {
      _count: {
        select: { executions: true, results: true, jvMeasurements: true },
      },
    },
  });
  const wanted = new Set(desired.map((s) => s.code.toUpperCase()));
  const removed = current.filter((s) => !wanted.has(s.code.toUpperCase()));
  const protectedRows = removed.filter(
    (s) =>
      s.simCode ||
      s.instrumentCodes.length ||
      s._count.executions ||
      s._count.results ||
      s._count.jvMeasurements,
  );
  if (protectedRows.length) {
    throw new Error(
      `Cannot remove samples with issued labels or recorded work (${protectedRows.map((s) => s.code).join(", ")}). Keep the batch size and move unused samples to Extras or Trash / problem.`,
    );
  }
  if (removed.length) {
    await tx.sample.deleteMany({
      where: { id: { in: removed.map((s) => s.id) } },
    });
  }
  const byCode = new Map(current.map((s) => [s.code.toUpperCase(), s]));
  for (const sample of desired) {
    const existing = byCode.get(sample.code.toUpperCase());
    if (existing) {
      if (existing.variationGroup !== sample.variationGroup) {
        await tx.sample.update({
          where: { id: existing.id },
          data: { variationGroup: sample.variationGroup },
        });
      }
    } else {
      await tx.sample.create({
        data: {
          experimentId,
          code: sample.code,
          variationGroup: sample.variationGroup,
        },
      });
    }
  }
}
