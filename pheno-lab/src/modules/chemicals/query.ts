import "server-only";
import crypto from "node:crypto";

import { db } from "@/infrastructure/db/client";
import type { Actor } from "@/modules/authorization/actor";
import {
  assertFullAccess,
  AuthorizationError,
} from "@/modules/authorization/policy";
import { chemicalIdSchema, chemicalListSchema } from "./schema";
import type { ChemicalRow } from "./types";
import { recordUserAudit } from "@/modules/audit/writer";

export async function requireChemicalAccess(
  actor: Actor,
  client: Pick<typeof db, "user"> = db,
) {
  assertFullAccess(actor);
  if ("device" in actor && actor.device) throw new AuthorizationError();
  const user = await client.user.findFirst({
    where: {
      id: actor.uid,
      organizationId: actor.org,
      active: true,
      pendingApproval: false,
      testingOnly: false,
      mustChangePassword: false,
      chemicalAccess: true,
      role: { in: ["ADMIN", "MANAGER"] },
      organization: { status: "ACTIVE" },
    },
    select: { id: true },
  });
  if (!user)
    throw new AuthorizationError("Private chemistry access is restricted.");
}

export async function canOpenChemicals(actor: Actor) {
  try {
    await requireChemicalAccess(actor);
    return true;
  } catch {
    return false;
  }
}

export const chemicalSelect = {
  id: true,
  name: true,
  category: true,
  smiles: true,
  archived: true,
  chemistry: {
    select: {
      canonicalSmiles: true,
      version: true,
      generatedAt: true,
      engineVersion: true,
      atomCount: true,
      inputSha256: true,
    },
  },
} as const;

export async function listChemicals(actor: Actor, raw: unknown) {
  await requireChemicalAccess(actor);
  const { page, q } = chemicalListSchema.parse(raw);
  const where = {
    organizationId: actor.org,
    archived: false,
    ...(q ? { name: { contains: q, mode: "insensitive" as const } } : {}),
  };
  const [rows, total, categories] = await Promise.all([
    db.material.findMany({
      where,
      select: chemicalSelect,
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: 40,
      skip: (page - 1) * 40,
    }),
    db.material.count({ where }),
    db.materialCategoryDef.findMany({
      where: { organizationId: actor.org },
      orderBy: { position: "asc" },
      select: { code: true, name: true, nameZh: true },
    }),
  ]);
  return { rows: rows.map(toChemicalRow), total, page, categories };
}

export function chemicalRowDigest(row: {
  name: string;
  category: string;
  smiles: string;
}) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([row.name, row.category, row.smiles]))
    .digest("hex");
}

export function toChemicalRow(
  row: Omit<ChemicalRow, "chemistry" | "rowDigest"> & {
    chemistry:
      | (Omit<NonNullable<ChemicalRow["chemistry"]>, "generatedAt"> & {
          generatedAt: Date;
        })
      | null;
  },
): ChemicalRow {
  return {
    ...row,
    rowDigest: chemicalRowDigest(row),
    chemistry: row.chemistry
      ? {
          ...row.chemistry,
          generatedAt: row.chemistry.generatedAt.toISOString(),
        }
      : null,
  };
}

export async function getChemicalForAnalysis(actor: Actor, rawId: unknown) {
  await requireChemicalAccess(actor);
  const id = chemicalIdSchema.parse(rawId);
  return db.material.findFirst({
    where: { id, organizationId: actor.org, archived: false },
    select: chemicalSelect,
  });
}

/** Explicitly private agent input; never used by public catalogue/export paths. */
export async function exportChemicalDefinitions(actor: Actor) {
  await requireChemicalAccess(actor);
  return db.$transaction(async (tx) => {
    const rows = await tx.material.findMany({
      where: { organizationId: actor.org, archived: false },
      select: chemicalSelect,
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: 5000,
    });
    await recordUserAudit(tx, {
      actor,
      action: "chemistry.definitions.exported",
      entityType: "Organization",
      entityId: actor.org,
      metadata: { materials: rows.length, classification: "private_chemistry" },
    });
    return {
      schemaVersion: 1,
      classification: "private_chemistry",
      generatedAt: new Date().toISOString(),
      usage:
        "Restricted chemistry evidence for authorized analysis. Do not expose SMILES or molecular images in reports distributed to other managers, or upload private definitions to public search.",
      materials: rows.map((row) => {
        const validated =
          !!row.chemistry &&
          row.chemistry.inputSha256 ===
            crypto.createHash("sha256").update(row.smiles).digest("hex");
        return {
          materialId: row.id,
          name: row.name,
          category: row.category,
          smiles: row.smiles,
          canonicalSmiles: validated ? row.chemistry!.canonicalSmiles : null,
          validation: validated ? "VALIDATED_NOTATION" : "UNVALIDATED",
          engineVersion: validated ? row.chemistry!.engineVersion : null,
          definitionVersion: row.chemistry?.version ?? 0,
          validatedAt: validated
            ? row.chemistry!.generatedAt.toISOString()
            : null,
        };
      }),
    };
  });
}
