import "server-only";

import { createHash } from "node:crypto";
import initRDKit, { type MainModule } from "@rdkit/rdkit";

let runtime: Promise<MainModule> | undefined;

export class InvalidSmilesError extends Error {
  constructor() {
    super("The SMILES could not be validated. Check the molecule notation.");
  }
}

/** Deterministic local chemistry; no provider calls or molecule data in logs. */
export async function renderMolecule(smiles: string) {
  // Accept SMILES notation, not other RDKit input formats such as molecule JSON.
  if (
    !smiles ||
    smiles.length > 4000 ||
    !/^[A-Za-z0-9@+\-\[\]().%=#$:\\/<>]+$/.test(smiles)
  )
    throw new InvalidSmilesError();
  runtime ??= initRDKit({ print: () => {}, printErr: () => {} }).catch(
    (error: unknown) => {
      runtime = undefined;
      throw error;
    },
  );
  const rdkit = await runtime;
  let molecule: ReturnType<MainModule["get_mol"]> = null;
  try {
    molecule = rdkit.get_mol(smiles);
    if (
      !molecule ||
      molecule.get_num_atoms() < 1 ||
      molecule.get_num_atoms() > 500
    )
      throw new InvalidSmilesError();
    const canonicalSmiles = molecule.get_smiles();
    // A wildcard is a placeholder, not an identified chemical structure.
    if (canonicalSmiles.includes("*")) throw new InvalidSmilesError();
    const svg = molecule.get_svg(560, 360);
    if (
      !svg.includes("<svg") ||
      /<(?:script|foreignObject)|\son\w+\s*=|(?:href|src)\s*=/i.test(svg) ||
      Buffer.byteLength(svg) > 500_000
    )
      throw new InvalidSmilesError();
    return {
      canonicalSmiles,
      svg,
      atomCount: molecule.get_num_atoms(),
      engineVersion: `RDKit ${rdkit.version()}`,
      inputSha256: createHash("sha256").update(smiles).digest("hex"),
      structureSha256: createHash("sha256").update(svg).digest("hex"),
      structureBytes: Buffer.byteLength(svg),
    };
  } catch (error) {
    if (error instanceof InvalidSmilesError) throw error;
    throw new InvalidSmilesError();
  } finally {
    molecule?.delete();
  }
}
