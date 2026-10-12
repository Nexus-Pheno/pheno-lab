import type { Material, Prisma } from "@prisma/client";

/** Public catalogue fields. Never include SMILES or private chemistry relations. */
export const publicMaterialSelect = {
  id: true,
  organizationId: true,
  processId: true,
  name: true,
  category: true,
  composition: true,
  casNumber: true,
  molecularWeight: true,
  purity: true,
  supplier: true,
  lot: true,
  properties: true,
  notes: true,
  archived: true,
  createdAt: true,
} as const satisfies Prisma.MaterialSelect;

export type PublicMaterial = Omit<Material, "smiles">;

export function assertPublicSmiles(value: unknown) {
  if (
    value !== undefined &&
    value !== null &&
    (typeof value !== "string" || value.trim())
  )
    throw new Error("Private chemistry must be edited in Pheno Chemicals.");
}

/** Legacy intake/suggestion JSON may contain SMILES; never echo it publicly. */
export function redactSmilesJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSmilesJson);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /smiles/i.test(key) ? "" : redactSmilesJson(item),
      ]),
    );
  return value;
}
