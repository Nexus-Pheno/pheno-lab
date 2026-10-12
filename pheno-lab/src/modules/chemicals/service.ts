import "server-only";

import crypto from "node:crypto";
import { db } from "@/infrastructure/db/client";
import { objectStorage } from "@/infrastructure/storage";
import { renderMolecule } from "@/infrastructure/chemistry/renderer";
export { InvalidSmilesError } from "@/infrastructure/chemistry/renderer";
import type { Actor } from "@/modules/authorization/actor";
import { recordUserAudit } from "@/modules/audit/writer";
import {
  chemicalSelect,
  requireChemicalAccess,
  toChemicalRow,
  chemicalRowDigest,
} from "./query";
import {
  chemicalCategorySchema,
  chemicalIdSchema,
  chemicalRowSchema,
  smilesSchema,
} from "./schema";

import { registrationTarget, registrationSelect } from "./registration";
import { ensureChemicalCategory } from "./category-service";

export class ChemicalConflictError extends Error {
  constructor(
    public readonly code:
      "conflict" | "exists" | "ambiguous" | "archived" = "conflict",
  ) {
    super(
      code === "conflict"
        ? "Material changed. Reload it before saving."
        : code === "exists"
          ? "This material already exists in Pheno Chemicals."
          : code,
    );
  }
}

export async function previewChemical(actor: Actor, raw: unknown) {
  await requireChemicalAccess(actor);
  const molecule = await renderMolecule(smilesSchema.parse(raw));
  return {
    svg: molecule.svg,
    canonicalSmiles: molecule.canonicalSmiles,
    atomCount: molecule.atomCount,
    engineVersion: molecule.engineVersion,
  };
}

export async function saveChemicalRow(actor: Actor, raw: unknown) {
  await requireChemicalAccess(actor);
  const input = chemicalRowSchema.parse(raw);
  const molecule = await renderMolecule(input.smiles);
  let uploadedKey: string | null = null;
  try {
    return await db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`chemical-save:${actor.org}`}, 0))`;
        const fresh = await tx.user.findFirst({
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
        if (!fresh) throw new Error("Private chemistry access is restricted.");
        const previousRequest = await tx.material.findFirst({
          where: {
            organizationId: actor.org,
            chemistry: { is: { requestId: input.requestId } },
          },
          select: { ...chemicalSelect, chemistry: true },
        });
        if (previousRequest) {
          if (
            (input.id
              ? previousRequest.name !== input.name
              : previousRequest.name.toLowerCase() !==
                input.name.toLowerCase()) ||
            previousRequest.category !== input.category ||
            previousRequest.smiles !== input.smiles ||
            (input.id && input.id !== previousRequest.id)
          )
            throw new ChemicalConflictError();
          return {
            row: toChemicalRow(
              await tx.material.findUniqueOrThrow({
                where: { id: previousRequest.id },
                select: chemicalSelect,
              }),
            ),
            created: false,
          };
        }
        let existing = input.id
          ? await tx.material.findFirst({
              where: {
                id: input.id,
                organizationId: actor.org,
                archived: false,
              },
              select: registrationSelect,
            })
          : null;
        if (input.id && !existing) throw new ChemicalConflictError();
        if (input.id) {
          if (
            (existing?.chemistry?.version ?? 0) !== input.expectedVersion ||
            (existing && input.expectedDigest !== chemicalRowDigest(existing))
          )
            throw new ChemicalConflictError();
          const duplicate = await tx.material.count({
            where: {
              organizationId: actor.org,
              name: { equals: input.name, mode: "insensitive" },
              id: { not: input.id },
            },
          });
          if (
            duplicate &&
            existing?.name.toLowerCase() !== input.name.toLowerCase()
          )
            throw new ChemicalConflictError("ambiguous");
        } else {
          if (input.expectedVersion !== 0 || input.expectedDigest !== null)
            throw new ChemicalConflictError();
          const matches = await tx.material.findMany({
            where: {
              organizationId: actor.org,
              name: { equals: input.name, mode: "insensitive" },
            },
            select: registrationSelect,
          });
          const target = registrationTarget(matches, input.name);
          if (target.issue) throw new ChemicalConflictError(target.issue);
          existing = target.material;
        }
        await ensureChemicalCategory(tx, actor, input.category);
        const id = existing?.id ?? crypto.randomUUID();
        const key = `organizations/${actor.org}/chemicals/${crypto.randomUUID()}.svg`;
        await objectStorage().put({
          key,
          body: Buffer.from(molecule.svg),
          contentType: "image/svg+xml",
          sha256: molecule.structureSha256,
        });
        uploadedKey = key;
        const data = {
          name: existing && !input.id ? existing.name : input.name,
          category: input.category,
          smiles: input.smiles,
        };
        if (existing) await tx.material.update({ where: { id }, data });
        else
          await tx.material.create({
            data: { id, ...data, organizationId: actor.org },
          });
        const evidence = {
          inSamRegistry: true,
          requestId: input.requestId,
          canonicalSmiles: molecule.canonicalSmiles,
          inputSha256: molecule.inputSha256,
          structurePath: key,
          structureSha256: molecule.structureSha256,
          structureBytes: molecule.structureBytes,
          atomCount: molecule.atomCount,
          engineVersion: molecule.engineVersion,
          version: (existing?.chemistry?.version ?? 0) + 1,
          generatedAt: new Date(),
        };
        await tx.materialChemistry.upsert({
          where: { materialId: id },
          create: { materialId: id, ...evidence },
          update: evidence,
        });
        await recordUserAudit(tx, {
          actor,
          action:
            existing && !input.id
              ? "chemistry.material.registered"
              : existing
                ? "chemistry.material.updated"
                : "chemistry.material.created",
          entityType: "Material",
          entityId: id,
          metadata: {
            category: input.category,
            version: evidence.version,
            engineVersion: molecule.engineVersion,
            hasValidatedStructure: true,
          },
        });
        return {
          row: toChemicalRow(
            await tx.material.findUniqueOrThrow({
              where: { id },
              select: chemicalSelect,
            }),
          ),
          created: !existing,
        };
      },
      { timeout: 30000 },
    );
  } catch (error) {
    if (uploadedKey) {
      try {
        if (
          !(await db.materialChemistry.count({
            where: { structurePath: uploadedKey },
          }))
        )
          await objectStorage().delete(uploadedKey);
      } catch {
        /* Preserve the object if the commit outcome cannot be confirmed. */
      }
    }
    throw error;
  }
}

export async function createChemicalCategory(actor: Actor, raw: unknown) {
  await requireChemicalAccess(actor);
  const input = chemicalCategorySchema.parse(raw);
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`chemical-save:${actor.org}`}, 0))`;
    await requireChemicalAccess(actor, tx);
    const builtin = (
      {
        sam: "SAM",
        additive: "ADDITIVE",
        additives: "ADDITIVE",
        添加剂: "ADDITIVE",
        solvent: "SOLVENT",
        solvents: "SOLVENT",
        溶剂: "SOLVENT",
      } as Record<string, string>
    )[input.name.toLowerCase()];
    if (builtin) {
      await ensureChemicalCategory(tx, actor, builtin);
      return tx.materialCategoryDef.findUniqueOrThrow({
        where: {
          organizationId_code: { organizationId: actor.org, code: builtin },
        },
        select: { code: true, name: true, nameZh: true },
      });
    }
    const same = await tx.materialCategoryDef.findFirst({
      where: {
        organizationId: actor.org,
        name: { equals: input.name, mode: "insensitive" },
      },
      select: { code: true, name: true, nameZh: true },
    });
    if (same) return same;
    const base =
      input.name
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, "_")
        .replace(/^_|_$/g, "")
        .slice(0, 80) || "CATEGORY";
    let code = base,
      index = 2;
    while (
      await tx.materialCategoryDef.count({
        where: { organizationId: actor.org, code },
      })
    )
      code = `${base}_${index++}`;
    const maximum = await tx.materialCategoryDef.aggregate({
      where: { organizationId: actor.org },
      _max: { position: true },
    });
    const row = await tx.materialCategoryDef.create({
      data: {
        organizationId: actor.org,
        code,
        ...input,
        position: (maximum._max.position ?? 0) + 1,
      },
      select: { id: true, code: true, name: true, nameZh: true },
    });
    await recordUserAudit(tx, {
      actor,
      action: "chemistry.category.created",
      entityType: "MaterialCategoryDef",
      entityId: row.id,
      changes: { code },
    });
    return { code: row.code, name: row.name, nameZh: row.nameZh };
  });
}

export async function readChemicalStructure(actor: Actor, rawId: unknown) {
  await requireChemicalAccess(actor);
  const id = chemicalIdSchema.parse(rawId);
  const row = await db.material.findFirst({
    where: { id, organizationId: actor.org, archived: false },
    select: { smiles: true, chemistry: true },
  });
  if (!row?.chemistry) return null;
  const evidence = row.chemistry;
  if (
    evidence.inputSha256 !==
      crypto.createHash("sha256").update(row.smiles).digest("hex") ||
    !evidence.structurePath.startsWith(`organizations/${actor.org}/chemicals/`)
  )
    return null;
  const body = await objectStorage().get(evidence.structurePath);
  if (
    !body ||
    body.byteLength !== evidence.structureBytes ||
    crypto.createHash("sha256").update(body).digest("hex") !==
      evidence.structureSha256
  )
    return null;
  return body;
}
