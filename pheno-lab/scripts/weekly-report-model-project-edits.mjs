import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";

const overviewFields = [
  "purpose",
  "decision",
  "priorIssues",
  "next",
  "confidence",
];
const intentFields = [
  "observation",
  "problem",
  "hypothesis",
  "purpose",
  "attainment",
  "comparison",
  "next",
];
const allowed = (x, i) => assert(i.includes(x), "Invalid project patch field");
const wording = (v) =>
  assert(
    v &&
      Object.keys(v).length === 2 &&
      typeof v.en === "string" &&
      typeof v.zh === "string",
    "Invalid project edit wording",
  );

export function replayProjectEdit(previous, patch) {
  const out = structuredClone(previous);
  const changed = new Set();
  function field(key) {
    if (changed.has(key)) throw Error("Duplicate project patch field");
    changed.add(key);
  }
  for (const edit of patch.overview) {
    allowed(edit.field, overviewFields);
    wording(edit.value);
    field(edit.field);
    out[edit.field] = edit.value;
  }
  for (const edit of patch.intents) {
    allowed(edit.field, intentFields);
    wording(edit.value);
    const row = out.routeIntents.find(
      (x) => x.experimentCode === edit.experimentCode,
    );
    if (!row) throw Error("Project patch references a different experiment");
    field(edit.experimentCode + "." + edit.field);
    row[edit.field] = edit.value;
  }
  for (const edit of patch.issues) {
    const idx = out.issueAssessments.findIndex((x) => x.key === edit.key);
    if (idx < 0)
      throw Error("Project patch references a different prior issue");
    allowed(edit.assessment, [
      "no-new-direct-test",
      "partial-test",
      "direct-test",
    ]);
    wording(edit.rationale);
    assert(
      Array.isArray(edit.testedExperimentCodes) &&
        edit.testedExperimentCodes.every((v) => typeof v === "string"),
    );
    assert(
      Object.keys(edit).every((k) =>
        ["assessment", "rationale", "key", "testedExperimentCodes"].includes(k),
      ),
    );
    field(edit.key);
    out.issueAssessments[idx] = edit;
  }
  if (patch.projectNameEn !== undefined) {
    assert(
      typeof patch.projectNameEn === "string" &&
        patch.projectNameEn.trim().length > 0 &&
        patch.projectNameEn.length <= 180,
    );
    out.projectNameEn = patch.projectNameEn;
  }
  if (patch.confidenceLevel) {
    allowed(patch.confidenceLevel, ["LOW", "MODERATE", "HIGH"]);
    out.confidenceLevel = patch.confidenceLevel;
  }
  if (patch.routeDisposition) {
    allowed(patch.routeDisposition, ["CONTINUE", "ADJUST", "HOLD"]);
    out.routeDisposition = patch.routeDisposition;
  }
  if (isDeepStrictEqual(previous, out))
    throw Error("Peer corrections failed to change the project manuscript");
  return out;
}

// Trace a targeted correction all the way back to the full candidate and actual
// rejected review. Only the provider's raw patch carries model output provenance.
export function verifyProjectAuthorship(
  record,
  evidence,
  pool,
  { hash, completion, seal },
  ancestry = new Set(),
) {
  const { author, patch } = record;
  assert(!ancestry.has(author.completionId), "Cyclic project revision");
  ancestry.add(author.completionId);
  assert.equal(author.evidenceHash, hash(evidence));
  if (!patch) {
    completion(author, "project-author");
    return;
  }
  const { base, provider } = patch;
  completion(provider, "project-reviser");
  assert.equal(author.authorship, "APPLIED_TARGETED_MODEL_EDIT");
  assert.equal(author.priorDraftHash, hash(base));
  assert.equal(author.providerOutputHash, provider.outputHash);
  for (const k of [
    "model",
    "provider",
    "providerHost",
    "completionId",
    "requestId",
    "requestHash",
    "promptHash",
    "evidenceHash",
    "inputHash",
    "role",
  ])
    assert.equal(author[k], provider[k]);
  assert.deepEqual(replayProjectEdit(base, provider.value), author.value);
  assert.equal(author.outputHash, hash(author.value));
  const prior = [...pool.values()].filter(({ attempt }) => {
    const previous = attempt.author;
    return (
      previous.completionId !== author.completionId &&
      previous.evidenceHash === author.evidenceHash &&
      previous.outputHash === author.priorDraftHash &&
      hash({
        evidence,
        revision: { previous: base, review: attempt.reviewer.value },
      }) === provider.inputHash
    );
  });
  assert.equal(
    prior.length,
    1,
    "Missing original project review or differing correction prompt",
  );
  const { file, attempt } = prior[0];
  seal(file);
  assert.deepEqual(base, attempt.author.value);
  assert(
    ["BLOCK", "REVISE"].includes(attempt.reviewer.value.decision) ||
      attempt.reviewer.value.findings.some((f) => f.severity === "blocking"),
    "Correction requires an actual adverse review",
  );
  completion(attempt.reviewer, "project-reviewer");
  assert.equal(attempt.reviewer.evidenceHash, hash(evidence));
  assert.equal(attempt.reviewer.inputHash, hash({ evidence, candidate: base }));
  verifyProjectAuthorship(
    attempt,
    evidence,
    pool,
    { hash, completion, seal },
    ancestry,
  );
}
