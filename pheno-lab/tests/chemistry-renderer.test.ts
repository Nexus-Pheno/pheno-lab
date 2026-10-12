import { describe, expect, it } from "vitest";
import {
  renderMolecule,
  InvalidSmilesError,
} from "@/infrastructure/chemistry/renderer";

describe("local validated molecular structures", () => {
  it("renders real aromatic, charged and stereochemical notation deterministically", async () => {
    for (const input of [
      "CCO",
      "c1ccccc1",
      "[Na+].[Cl-]",
      "N->[Cu+2]",
      "C[C@H](O)C(=O)O",
    ]) {
      const first = await renderMolecule(input),
        second = await renderMolecule(input);
      expect(first.svg).toContain("<svg");
      expect(first.svg).not.toMatch(/<script|href=/i);
      expect(first.canonicalSmiles).toBeTruthy();
      expect(first.atomCount).toBeGreaterThan(0);
      expect(first.structureBytes).toBe(Buffer.byteLength(first.svg));
      expect(first.structureSha256).toBe(second.structureSha256);
      expect(first.engineVersion).toMatch(/^RDKit /);
    }
  });
  it("rejects malformed notation, impossible valence, placeholders and markup", async () => {
    for (const input of [
      "not-smiles",
      "C(C)(C)(C)(C)C",
      "*",
      "C</svg>",
      "C C",
      '{"molecules":[]}',
      "C".repeat(501),
    ])
      await expect(renderMolecule(input)).rejects.toBeInstanceOf(
        InvalidSmilesError,
      );
  });
});
