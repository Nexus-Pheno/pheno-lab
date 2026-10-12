export type ChemicalRow = {
  id: string;
  name: string;
  category: string;
  smiles: string;
  archived: boolean;
  rowDigest: string;
  chemistry: {
    canonicalSmiles: string;
    version: number;
    generatedAt: string;
    engineVersion: string;
    atomCount: number;
    inputSha256: string;
  } | null;
};
export type ChemicalCategory = { code: string; name: string; nameZh: string };
export type MoleculePreview = {
  svg: string;
  canonicalSmiles: string;
  atomCount: number;
  engineVersion: string;
};
