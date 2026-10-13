import { describe, expect, it } from "vitest";
import {
  applyChemicalImportReview,
  chemicalImportReviewSchema,
  chemicalReviewDigest,
  storedChemicalReviewDigest,
} from "@/modules/chemicals/bulk-review";

describe("chemical workbook draft review", () => {
  const source = [
    { row: 2, cells: ["Original", "CCO"] },
    { row: 4, cells: ["Remove", "CCO"] },
    { row: 7, cells: ["Unchanged name", "CCN", "unexpected column"] },
  ];
  it("edits only explicit fields, excludes selected source rows and preserves the original workbook mapping", () => {
    const review = chemicalImportReviewSchema.parse({
      edits: [{ row: 7, smiles: " c1ccccc1 " }],
      excludedRows: [4],
    });
    expect(applyChemicalImportReview(source, review)).toEqual([
      { row: 2, cells: ["Original", "CCO"] },
      { row: 7, cells: ["Unchanged name", "c1ccccc1", "unexpected column"] },
    ]);
    expect(source[2].cells).toEqual([
      "Unchanged name",
      "CCN",
      "unexpected column",
    ]);
    expect(() =>
      applyChemicalImportReview(source, {
        edits: [{ row: 3, name: "Unknown" }],
        excludedRows: [],
      }),
    ).toThrow("different workbook row");
  });
  it("rejects repeated or unknown controls, header rows, overlength fields and overlapping removal/edits", () => {
    for (const review of [
      {
        edits: [
          { row: 2, name: "a" },
          { row: 2, name: "b" },
        ],
      },
      { excludedRows: [4, 4] },
      { edits: [{ row: 2, name: "a" }], excludedRows: [2] },
      { edits: [{ row: 2, materialId: "not-accepted", name: "a" }] },
      { edits: [{ row: 2 }] },
      { excludedRows: [1] },
      { edits: [{ row: 2, name: "a".repeat(201) }] },
    ])
      expect(chemicalImportReviewSchema.safeParse(review).success).toBe(false);
  });
  it("binds edits, removals, file and category; input ordering is irrelevant and legacy replay stays compatible", () => {
    const sourceHash = "a".repeat(64);
    const first = {
      edits: [
        { row: 7, smiles: "CCO" },
        { row: 2, name: "New name" },
      ],
      excludedRows: [4],
    };
    const sha = chemicalReviewDigest(sourceHash, "SAM", first);
    expect(
      chemicalReviewDigest(sourceHash, "SAM", {
        ...first,
        edits: [...first.edits].reverse(),
      }),
    ).toBe(sha);
    expect(chemicalReviewDigest(sourceHash, "SOLVENT", first)).not.toBe(sha);
    expect(
      chemicalReviewDigest(sourceHash, "SAM", { ...first, excludedRows: [] }),
    ).not.toBe(sha);
    expect(
      storedChemicalReviewDigest([{ category: "SAM" }], sourceHash, "SAM"),
    ).toBe(
      chemicalReviewDigest(sourceHash, "SAM", { edits: [], excludedRows: [] }),
    );
    expect(
      storedChemicalReviewDigest(
        [{ review: { sha256: sha } }],
        sourceHash,
        "SAM",
      ),
    ).toBe(sha);
    expect(() =>
      storedChemicalReviewDigest([{ review: {} }], sourceHash, "SAM"),
    ).toThrow("reconciliation");
  });
});
