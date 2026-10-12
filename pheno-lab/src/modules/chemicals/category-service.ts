import "server-only";
import type { Prisma } from "@prisma/client";
import type { Actor } from "@/modules/authorization/actor";
import { recordUserAudit } from "@/modules/audit/writer";

export async function ensureChemicalCategory(
  tx: Prisma.TransactionClient,
  actor: Actor,
  code: string,
) {
  const defaults: Record<string, { name: string; nameZh: string }> = {
    SAM: { name: "SAM", nameZh: "SAM" },
    ADDITIVE: { name: "Additive", nameZh: "添加剂" },
    SOLVENT: { name: "Solvent", nameZh: "溶剂" },
    OTHER: { name: "Other", nameZh: "其他" },
  };
  const existing = await tx.materialCategoryDef.count({
    where: { organizationId: actor.org, code },
  });
  if (existing) return;
  if (!defaults[code])
    throw new Error("Choose a category from this organization.");
  const maximum = await tx.materialCategoryDef.aggregate({
    where: { organizationId: actor.org },
    _max: { position: true },
  });
  const category = await tx.materialCategoryDef.create({
    data: {
      organizationId: actor.org,
      code,
      ...defaults[code],
      builtIn: true,
      position: (maximum._max.position ?? 0) + 1,
    },
  });
  await recordUserAudit(tx, {
    actor,
    action: "chemistry.category.created",
    entityType: "MaterialCategoryDef",
    entityId: category.id,
    metadata: { code, builtIn: true },
  });
}
