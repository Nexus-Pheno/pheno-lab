// Shared material/recipe metadata usable from both server actions and
// client components ("use server" files may only export async functions).

/** Category codes are org-defined (MaterialCategoryDef) — free-form strings. */
export type MaterialCategory = string;

export type MaterialCard = {
  name: string;
  category: string;
  composition: string;
  smiles: string;
  casNumber: string;
  molecularWeight: string;
  purity: string;
  supplier: string;
  lot: string;
  properties: Record<string, string>;
  notes: string;
  processId: string | null;
};

export type RecipePayload = {
  components: RecipeComponent[];
  solvents: string;
  concentration: string;
  procedure: string;
  // Formula sheet fields — filled by ingestion, optional for hand-written
  // recipes. Editors must preserve them (see RecipeModal).
  composition?: string; // ABX3 stoichiometry, e.g. Cs0.05FA0.79MA0.16Pb(I0.83Br0.17)3
  bandGap?: string; // eV
  notes?: string;
};

export type RecipeComponent = {
  material: string;
  amount: string;
  /** Free text: "A-site cation", "additive", "solvent"… */
  role?: string;
};
