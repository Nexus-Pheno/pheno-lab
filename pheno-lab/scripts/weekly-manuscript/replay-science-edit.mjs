import assert from "node:assert/strict";

const publicPath =
  /^cases\.\d+\.public\.(?:(?:name|purpose|comparison|attainment|result|judgment|keyIssue|nextStep|materialProposal|reasoning|alternative|discriminator|criteria)|designInterpretation\.(?:observation|problem|hypothesis|retrospectiveOrProspective)|signatures\.(?:cochangedFactors|(?:preferredCause|alternativeCause)\.(?:quantity|unit|expectedChange))|conditions\.\d+\.(?:condition|execution)|branches\.(?:positive|negative|mixed))$/;
const privatePath =
  /^cases\.\d+\.chemical\.(?:priority|carrierContext|identityBoundary|(?:criteria|limitations|controls|alternatives|graphHypotheses|compatibility)\.\d+|recipes\.\d+\.(?:coarseAbsorberContext|solventRole))$/;
const otherPassage =
  /^(?:priorities\.\d+|followupAssessments\.\d+\.rationale)$/;

export function replayScienceEdit(previous, edit) {
  const result = structuredClone(previous),
    seen = new Set();
  for (const { path, replacement } of edit.changes) {
    assert(!seen.has(path), "Duplicate scientific wording correction");
    seen.add(path);
    const bilingual = publicPath.test(path) || otherPassage.test(path);
    assert(
      bilingual || privatePath.test(path),
      "Unknown or protected scientific edit field",
    );
    const keys = path.split(".");
    let target = result;
    for (const key of keys.slice(0, -1)) {
      assert(
        target && typeof target === "object" && Object.hasOwn(target, key),
        "Scientific correction refers to an absent row",
      );
      target = target[key];
    }
    const field = keys.at(-1);
    assert(
      target && Object.hasOwn(target, field),
      "Scientific correction refers to an absent field",
    );
    const prior = target[field];
    const validBi = (v) =>
      v &&
      typeof v === "object" &&
      Object.keys(v).length === 2 &&
      typeof v.en === "string" &&
      typeof v.zh === "string" &&
      v.en.trim() &&
      v.zh.trim();
    assert(
      bilingual
        ? validBi(prior) && validBi(replacement)
        : typeof prior === "string" &&
            typeof replacement === "string" &&
            replacement.trim(),
      "Scientific correction has the wrong language shape",
    );
    target[field] = replacement;
  }
  assert(seen.size > 0, "Scientific correction is empty");
  return result;
}

export async function verifyScienceEditChain(runDirectory, receipt) {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { createHash } = await import("node:crypto");
  const files = [],
    completions = new Set();
  async function read(name) {
    files.push(name);
    return JSON.parse(await readFile(join(runDirectory, name), "utf8"));
  }
  const hash = (v) =>
    createHash("sha256")
      .update(
        JSON.stringify(v, (_k, x) =>
          x && typeof x === "object" && !Array.isArray(x)
            ? Object.fromEntries(
                Object.keys(x)
                  .sort()
                  .map((k) => [k, x[k]]),
              )
            : x,
        ),
      )
      .digest("hex");
  const attempts = receipt.targetedScienceEdits,
    baseAttempt = receipt.targetedScienceBaseAttempt;
  assert(Number.isInteger(attempts) && attempts >= 1 && attempts <= 2);
  assert(Number.isInteger(baseAttempt) && baseAttempt >= 1 && baseAttempt <= 5);
  const frozen = await read("science-source-selection.json");
  const publicDraft =
    frozen.publicDraftHash === null
      ? null
      : await read("manuscript-candidate.json");
  assert.equal(
    publicDraft === null ? null : hash(publicDraft),
    frozen.publicDraftHash,
  );
  const evidence = {
    ...(await read("private-scientific-facts.json")),
    publicEvidence: await read("provider-packet.json"),
    publicDraft,
  };
  const evidenceHash = hash(evidence);
  assert.equal(evidenceHash, frozen.evidenceHash);
  const anchor = await read("scientific-edit-anchor.json");
  const base = await read(`scientist-attempt-${baseAttempt}.json`),
    prior = await read(`scientific-peer-attempt-${baseAttempt}.json`);
  function check(record, role) {
    assert.equal(record.role, role);
    assert.equal(record.model, "deepseek-v4-pro");
    assert.equal(record.provider, "deepseek");
    assert.equal(record.providerHost, "api.deepseek.com");
    assert(
      record.requestId &&
        record.completionId &&
        !completions.has(record.completionId),
    );
    completions.add(record.completionId);
    assert.equal(record.evidenceHash, evidenceHash);
    assert.equal(record.outputHash, hash(record.value));
  }
  check(base, "scientist");
  check(prior, "chemist-reviewer");
  assert.deepEqual(anchor, {
    baseAttempt,
    evidenceHash,
    baseOutputHash: base.outputHash,
    priorReviewHash: prior.outputHash,
  });
  assert.equal(prior.bindingFailure, null);
  assert.equal(prior.reviewedInterpretationHash, base.outputHash);
  assert.equal(prior.authorCompletionId, base.completionId);
  assert.equal(prior.inputHash, hash({ evidence, interpretation: base.value }));
  let previous = base.value,
    review = prior.value;
  for (let i = 1; i <= attempts; i++) {
    assert.equal(review.decision, "REVISE");
    assert(review.findings.length);
    const editor = await read(`science-edit-${baseAttempt}-${i}-provider.json`),
      peer = await read(`science-edit-${baseAttempt}-${i}-peer.json`);
    check(editor, "scientific-reviser");
    check(peer, "chemist-reviewer");
    assert.equal(
      editor.inputHash,
      hash({ evidence, revision: { previous, review } }),
    );
    previous = replayScienceEdit(previous, editor.value);
    assert.equal(peer.inputHash, hash({ evidence, interpretation: previous }));
    review = peer.value;
    if (i === attempts) {
      assert.equal(review.decision, "PASS");
      assert(review.findings.every((f) => f.severity !== "blocking"));
      assert.equal(receipt.authorCompletionId, editor.completionId);
      for (const field of [
        "inputHash",
        "outputHash",
        "evidenceHash",
        "completionId",
        "requestId",
        "requestHash",
        "promptHash",
        "role",
        "model",
        "provider",
        "providerHost",
      ])
        assert.equal(receipt[field], peer[field]);
      assert.deepEqual(review, receipt.value);
    }
  }
  assert.equal(hash(previous), receipt.reviewedInterpretationHash);
  assert.deepEqual(previous, await read("science-interpretation.json"));
  return { files, completionIds: [...completions] };
}
