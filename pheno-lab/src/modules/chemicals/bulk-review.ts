import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import type { ChemicalImportReview } from "./bulk-types";

export class ChemicalImportConflict extends Error {}
export const MAX_CHEMICAL_REVIEW_BYTES = 5 * 1024 * 1024;
const sourceRow = z.number().int().min(2).max(1048576);
export const chemicalImportReviewSchema = z
  .object({
    edits: z
      .array(
        z
          .object({
            row: sourceRow,
            name: z.string().trim().max(200).optional(),
            smiles: z.string().trim().max(4000).optional(),
          })
          .strict()
          .refine(
            (edit) => edit.name !== undefined || edit.smiles !== undefined,
          ),
      )
      .default([]),
    excludedRows: z.array(sourceRow).default([]),
  })
  .strict()
  .superRefine((review, context) => {
    const edited = new Set(review.edits.map((edit) => edit.row));
    const excluded = new Set(review.excludedRows);
    if (
      edited.size !== review.edits.length ||
      excluded.size !== review.excludedRows.length ||
      review.edits.some((edit) => excluded.has(edit.row))
    )
      context.addIssue({
        code: "custom",
        message: "Each source row may occur only once in the review.",
      });
    if (Buffer.byteLength(JSON.stringify(review)) > MAX_CHEMICAL_REVIEW_BYTES)
      context.addIssue({ code: "custom", message: "The review is too large." });
  });

export function applyChemicalImportReview(
  entries: { row: number; cells: unknown[] }[],
  review: ChemicalImportReview,
) {
  const sourceRows = new Set(entries.map((entry) => entry.row));
  if (
    [...review.edits.map((edit) => edit.row), ...review.excludedRows].some(
      (row) => !sourceRows.has(row),
    )
  )
    throw new ChemicalImportConflict(
      "The review references a different workbook row.",
    );
  const edits = new Map(review.edits.map((edit) => [edit.row, edit]));
  const excluded = new Set(review.excludedRows);
  return entries
    .filter((entry) => !excluded.has(entry.row))
    .map((entry) => {
      const edit = edits.get(entry.row);
      const cells = [...entry.cells];
      if (edit?.name !== undefined) cells[0] = edit.name;
      if (edit?.smiles !== undefined) cells[1] = edit.smiles;
      return { row: entry.row, cells };
    });
}

/** Bind source, category and the exact reviewed proposal; source row numbers stay immutable. */
export function chemicalReviewDigest(
  sourceSha256: string,
  category: string,
  review: ChemicalImportReview,
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        sourceSha256,
        category,
        edits: [...review.edits]
          .sort((a, b) => a.row - b.row)
          .map((edit) => ({
            row: edit.row,
            ...(edit.name !== undefined ? { name: edit.name } : {}),
            ...(edit.smiles !== undefined ? { smiles: edit.smiles } : {}),
          })),
        excludedRows: [...review.excludedRows].sort((a, b) => a - b),
      }),
    )
    .digest("hex");
}

export function storedChemicalReviewDigest(
  manifest: unknown,
  sourceSha256: string,
  category: string,
) {
  if (Array.isArray(manifest) && manifest[0]?.review !== undefined) {
    const value = manifest[0].review?.sha256;
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
      throw new ChemicalImportConflict(
        "The stored review requires reconciliation.",
      );
    return value;
  }
  // Existing batches bind the unchanged original workbook and category.
  return chemicalReviewDigest(sourceSha256, category, {
    edits: [],
    excludedRows: [],
  });
}
