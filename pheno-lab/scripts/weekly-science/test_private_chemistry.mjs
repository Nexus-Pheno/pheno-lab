import assert from "node:assert/strict";
import init from "@rdkit/rdkit";
import crypto from "node:crypto";
import {
  describePrivateChemistry,
  countSubstructureMatches,
  compilePrivateMatchers,
} from "./describe_private_chemistry.mjs";
const r = await init({ print: () => {}, printErr: () => {} });
const smiles = "CP(=O)(O)O";
const m = r.get_mol(smiles),
  canonical = m.get_smiles();
m.delete();
const valid = {
  materialAlias: "synthetic-a",
  name: "Public reference",
  category: "SAM",
  smiles,
  chemistry: {
    inputSha256: crypto.createHash("sha256").update(smiles).digest("hex"),
    canonicalSmiles: canonical,
    version: 1,
  },
};
const noMotifSmiles = "CCO";
const noMotifMol = r.get_mol(noMotifSmiles),
  noMotifCanonical = noMotifMol.get_smiles();
noMotifMol.delete();
const noMotifs = {
  ...valid,
  materialAlias: "synthetic-zero",
  name: "Public solvent reference",
  smiles: noMotifSmiles,
  chemistry: {
    ...valid.chemistry,
    inputSha256: crypto
      .createHash("sha256")
      .update(noMotifSmiles)
      .digest("hex"),
    canonicalSmiles: noMotifCanonical,
  },
};
const result = await describePrivateChemistry({
  chemistryAccessAvailable: true,
  privateChemistryDefinitions: [
    valid,
    { ...valid, materialAlias: "synthetic-b", smiles: "CCO" },
    { materialAlias: "synthetic-c", name: "Unreviewed", smiles: "CCO" },
    noMotifs,
  ],
});
assert.equal(result.materials[0].status, "VALIDATED_CURRENT_GRAPH");
assert.equal(result.materials[0].descriptors.heavyAtoms, 5);
assert.equal(result.materials[0].motifCounts.phosphonicAcid, 1);
assert.equal(result.materials[0].motifCounts.thiol, 0);
assert.equal(result.materials[1].status, "HASH_MISMATCH");
assert.equal(result.materials[2].status, "UNVALIDATED_DEFINITION");
assert.equal(result.materials[2].descriptors, undefined);
const roundTrip = JSON.parse(JSON.stringify(result));
assert.equal(roundTrip.materials[3].status, "VALIDATED_CURRENT_GRAPH");
assert.equal(Object.keys(roundTrip.materials[3].motifCounts).length, 6);
assert.ok(
  Object.values(roundTrip.materials[3].motifCounts).every(
    (count) => count === 0,
  ),
);
assert.equal(roundTrip.materials[0].motifCounts.phosphonicAcid, 1);
assert.equal(countSubstructureMatches("{}"), 0);
assert.equal(countSubstructureMatches("[]"), 0);
assert.equal(countSubstructureMatches('[{"atoms":[0],"bonds":[]}]'), 1);
for (const malformed of [
  null,
  "null",
  "1",
  "true",
  '{"atoms":[]}',
  "[null]",
  "[{}]",
  '[{"atoms":[],"bonds":[]}]',
  '[{"atoms":[-1],"bonds":[]}]',
  "not-json",
])
  assert.throws(
    () => countSubstructureMatches(malformed),
    /Invalid private chemistry matcher result/,
  );
assert.throws(
  () => compilePrivateMatchers({ get_qmol: () => null }),
  /Invalid compiled private chemistry matcher/,
);
let calls = 0,
  deleted = 0;
assert.throws(
  () =>
    compilePrivateMatchers({
      get_qmol: () => ({
        is_valid: () => ++calls === 1,
        get_num_atoms: () => 1,
        delete: () => deleted++,
      }),
    }),
  /Invalid compiled private chemistry matcher/,
);
assert.equal(deleted, 2);
assert.throws(
  () =>
    compilePrivateMatchers({
      get_qmol: () => ({
        is_valid: () => true,
        get_num_atoms: () => 0,
        delete: () => {},
      }),
    }),
  /Invalid compiled private chemistry matcher/,
);
assert.equal(
  (
    await describePrivateChemistry({
      chemistryAccessAvailable: false,
      privateChemistryDefinitions: [valid],
    })
  ).materials.length,
  0,
);
assert.equal(JSON.stringify(result).includes(smiles), false);
assert.equal(JSON.stringify(result).includes(noMotifSmiles), false);
assert.equal(JSON.stringify(result).includes("<svg"), false);
console.log(
  "Private descriptor safeguards and matcher-shape regressions passed.",
);
