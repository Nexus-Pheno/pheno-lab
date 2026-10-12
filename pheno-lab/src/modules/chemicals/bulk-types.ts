import type { MoleculePreview } from "./types";

export type ChemicalImportIssue =
  | "name"
  | "smiles"
  | "text"
  | "columns"
  | "duplicate"
  | "exists"
  | "invalidSmiles";
export type ChemicalImportRow = {
  row: number;
  name: string;
  smiles: string;
  issues: ChemicalImportIssue[];
  preview: MoleculePreview | null;
};
export type ChemicalImportPreview = {
  fileSha256: string;
  rows: ChemicalImportRow[];
  valid: boolean;
};
