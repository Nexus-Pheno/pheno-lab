import type { MoleculePreview } from "./types";

export type ChemicalImportIssue =
  | "name"
  | "smiles"
  | "text"
  | "columns"
  | "duplicate"
  | "exists"
  | "ambiguous"
  | "archived"
  | "invalidSmiles";
export type ChemicalImportRow = {
  row: number;
  name: string;
  smiles: string;
  issues: ChemicalImportIssue[];
  preview: MoleculePreview | null;
  linksExisting: boolean;
};
export type ChemicalImportPreview = {
  fileSha256: string;
  category: string;
  rows: ChemicalImportRow[];
  valid: boolean;
};
