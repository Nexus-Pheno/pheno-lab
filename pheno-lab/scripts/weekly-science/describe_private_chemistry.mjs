#!/usr/bin/env node
// Local graph descriptors only. This output must never enter manager HTML or public research.
import init from "@rdkit/rdkit";
import { readFile, open, mkdir } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const patterns = {
  phosphonicAcid: "[P](=O)([O;H1,-1])[O;H1,-1]",
  carboxylicAcid: "C(=O)[O;H1,-1]",
  thiol: "[S;H1]",
  neutralAmine: "[N;X3;+0;!$(NC=O)]",
  aromaticAcceptor: "[n;H0;+0]",
  carbonyl: "[CX3]=[OX1]",
};
export function countSubstructureMatches(serialized) {
  let matches;
  try {
    if (typeof serialized !== "string") throw new Error();
    matches = JSON.parse(serialized);
  } catch {
    throw new Error("Invalid private chemistry matcher result.");
  }
  if (Array.isArray(matches)) {
    if (
      !matches.every(
        (match) =>
          match &&
          typeof match === "object" &&
          !Array.isArray(match) &&
          Array.isArray(match.atoms) &&
          match.atoms.length > 0 &&
          Array.isArray(match.bonds) &&
          [...match.atoms, ...match.bonds].every(
            (index) => Number.isInteger(index) && index >= 0,
          ),
      )
    )
      throw new Error("Invalid private chemistry matcher result.");
    return matches.length;
  }
  // RDKit returns {} rather than [] when a valid query has no matches.
  if (
    matches &&
    typeof matches === "object" &&
    Object.keys(matches).length === 0
  )
    return 0;
  throw new Error("Invalid private chemistry matcher result.");
}
export function compilePrivateMatchers(runtime) {
  const queries = {};
  try {
    for (const [key, pattern] of Object.entries(patterns)) {
      const query = runtime.get_qmol(pattern);
      queries[key] = query;
      if (
        !query ||
        typeof query.is_valid !== "function" ||
        !query.is_valid() ||
        typeof query.get_num_atoms !== "function" ||
        !Number.isInteger(query.get_num_atoms()) ||
        query.get_num_atoms() < 1
      )
        throw new Error("Invalid compiled private chemistry matcher.");
    }
    return queries;
  } catch {
    for (const query of Object.values(queries))
      if (typeof query?.delete === "function") query.delete();
    throw new Error("Invalid compiled private chemistry matcher.");
  }
}
export async function describePrivateChemistry(snapshot) {
  const output = {
    classification: "PRIVATE_CHEMISTRY_DESCRIPTORS_DO_NOT_PUBLISH",
    snapshotAt: snapshot.snapshotAt,
    chemistryAccessAvailable: snapshot.chemistryAccessAvailable === true,
    definitionBasis: "CURRENT_REGISTERED_GRAPH_NOT_HISTORICAL_LOT_PROOF",
    method:
      "Pinned local RDKit graph descriptors; no provider calls, no SVGs, no quantum calculation.",
    limitations: [
      "Descriptors do not establish purity, solubility, pKa, energy levels, adsorption geometry, binding energy, historical identity or causal performance.",
      "All descriptors and feature vectors remain private; shared reports use reviewed non-reconstructive interpretations only.",
    ],
    materials: [],
  };
  if (!output.chemistryAccessAvailable) return output;
  const runtime = await init({ print: () => {}, printErr: () => {} });
  const queries = compilePrivateMatchers(runtime);
  try {
    for (const definition of snapshot.privateChemistryDefinitions ?? []) {
      const { materialAlias, name, category, smiles, chemistry } = definition;
      const status =
        typeof smiles !== "string" || !smiles
          ? "NO_DEFINITION"
          : !chemistry
            ? "UNVALIDATED_DEFINITION"
            : sha(smiles) !== chemistry.inputSha256
              ? "HASH_MISMATCH"
              : "VALIDATED_CURRENT_GRAPH";
      const row = {
        materialAlias,
        name,
        category,
        status,
        definitionVersion: chemistry?.version ?? null,
        generatedAt: chemistry?.generatedAt ?? null,
        historicalLotVerified: false,
      };
      if (status !== "VALIDATED_CURRENT_GRAPH") {
        output.materials.push(row);
        continue;
      }
      let molecule;
      try {
        molecule = runtime.get_mol(smiles);
        if (
          !molecule ||
          molecule.get_num_atoms() < 1 ||
          molecule.get_num_atoms() > 500 ||
          molecule.get_smiles().includes("*")
        )
          throw new Error("Invalid submitted graph");
        if (molecule.get_smiles() !== chemistry.canonicalSmiles)
          throw new Error("Canonical evidence mismatch");
        const d = JSON.parse(molecule.get_descriptors()),
          j = JSON.parse(molecule.get_json());
        row.descriptors = {
          molecularWeight: d.amw,
          heavyAtoms: d.NumHeavyAtoms,
          hBondAcceptors: d.NumHBA,
          hBondDonors: d.NumHBD,
          aromaticRings: d.NumAromaticRings,
          rotatableBonds: d.NumRotatableBonds,
          polarSurfaceArea: d.tpsa,
          calculatedLogP: d.CrippenClogP,
          formalCharge: j.molecules[0].atoms.reduce(
            (sum, a) => sum + (a.chg ?? j.defaults.atom.chg ?? 0),
            0,
          ),
          fragments: molecule.get_smiles().split(".").length,
        };
        row.motifCounts = Object.fromEntries(
          Object.entries(queries).map(([key, q]) => [
            key,
            countSubstructureMatches(molecule.get_substruct_matches(q)),
          ]),
        );
        row.descriptorInterpretation =
          "Hypothesis features only; mechanistic significance requires measured interface/solution/film evidence.";
      } catch {
        row.status = "INVALID_OR_STALE_GRAPH";
        delete row.descriptors;
        delete row.motifCounts;
        delete row.descriptorInterpretation;
      } finally {
        molecule?.delete();
      }
      output.materials.push(row);
    }
  } finally {
    for (const q of Object.values(queries)) q?.delete();
  }
  return output;
}
if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output)
    throw new Error("Provide private snapshot and new private output");
  const result = await describePrivateChemistry(
    JSON.parse(await readFile(input, "utf8")),
  );
  await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  const file = await open(output, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(result, null, 2) + "\n");
  } finally {
    await file.close();
  }
  console.log(
    JSON.stringify({
      saved: output,
      definitions: result.materials.length,
      validated: result.materials.filter(
        (m) => m.status === "VALIDATED_CURRENT_GRAPH",
      ).length,
      private: true,
    }),
  );
}
