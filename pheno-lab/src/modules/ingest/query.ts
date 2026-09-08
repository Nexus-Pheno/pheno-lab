import "server-only";
import { fmtBeijing } from "@/lib/datetime";

import { db } from "@/infrastructure/db/client";
import type { Actor } from "@/modules/authorization/actor";
import { assertStaff } from "@/modules/authorization/policy";
import { hasStewardship } from "@/modules/stewardship/service";

export async function getIngestReviewData(actor: Actor) {
  assertStaff(actor);
  const formulaSteward = await hasStewardship(actor, "recipeSteward");
  const [items, processes, categories, materials] = await Promise.all([
    db.ingestItem.findMany({
      where: {
        organizationId: actor.org,
        ...(formulaSteward ? {} : { kind: { not: "FORMULA" } }),
      },
      orderBy: [{ createdAt: "desc" }],
      select: {
        id: true,
        kind: true,
        status: true,
        title: true,
        sourceFile: true,
        confidence: true,
        reviewNote: true,
        publishedId: true,
        createdAt: true,
        reviewedAt: true,
        reviewedBy: { select: { name: true } },
      },
      take: 2_000,
    }),
    db.process.findMany({
      where: { organizationId: actor.org, archived: false },
      orderBy: { position: "asc" },
      select: { name: true },
    }),
    db.materialCategoryDef.findMany({
      where: { organizationId: actor.org },
      orderBy: { position: "asc" },
      select: { code: true, name: true },
    }),
    db.material.findMany({
      where: { organizationId: actor.org, archived: false },
      select: { name: true },
    }),
  ]);
  return {
    items: items.map((item) => ({
      id: item.id,
      kind: item.kind,
      status: item.status,
      title: item.title,
      sourceFile: item.sourceFile,
      confidence: item.confidence,
      reviewNote: item.reviewNote,
      createdAt: fmtBeijing(item.createdAt, "date"),
      reviewedAt: item.reviewedAt ? fmtBeijing(item.reviewedAt, "date") : null,
      reviewedBy: item.reviewedBy?.name ?? null,
    })),
    processNames: processes.map((process) => process.name),
    categories,
    materialNames: materials.map((material) => material.name),
  };
}
