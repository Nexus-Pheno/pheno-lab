import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

function canonical(value) {
  return JSON.stringify(value, (_, v) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return v;
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, v[k]]),
    );
  });
}

async function main() {
  const run = process.argv[2];
  const data = async (file) =>
    JSON.parse(await readFile(join(run, file), "utf8"));
  const hash = (value) =>
    createHash("sha256").update(canonical(value)).digest("hex");
  const receipt = await data("independent-material-science-review.json");
  assert(Object.hasOwn(receipt, "publicDraftAtScienceSha256"));
  const draft =
    receipt.publicDraftAtScienceSha256 === null
      ? null
      : await data("manuscript-candidate.json");
  if (draft !== null)
    assert.equal(hash(draft), receipt.publicDraftAtScienceSha256);
  const evidence = {
    ...(await data("private-scientific-facts.json")),
    publicEvidence: await data("provider-packet.json"),
    publicDraft: draft,
  };
  const interpretation = await data("science-interpretation.json");
  assert.equal(receipt.reviewedInterpretationHash, hash(interpretation));
  assert.equal(receipt.evidenceHash, hash(evidence));
  assert.equal(receipt.inputHash, hash({ evidence, interpretation }));
  assert.equal(receipt.outputHash, hash(receipt.value));
  assert.notEqual(receipt.completionId, receipt.authorCompletionId);
  assert(
    receipt.authorCompletionId &&
      receipt.bindingFailure === null &&
      receipt.value.decision === "PASS",
  );
  assert.equal(receipt.value.scientificAudit.length, evidence.cases.length);
  for (const c of evidence.cases) {
    assert.equal(
      receipt.value.scientificAudit.filter(
        (a) =>
          a.experiment === c.experiment &&
          a.sourceHash === c.sourceHash &&
          a.verdict === "PASS",
      ).length,
      1,
    );
  }
  assert(receipt.value.findings.every((item) => item.severity !== "blocking"));
  let chain;
  if (
    Object.hasOwn(receipt, "targetedScienceBaseAttempt") ||
    Object.hasOwn(receipt, "targetedScienceEdits")
  ) {
    const { verifyScienceEditChain } =
      await import("../weekly-manuscript/replay-science-edit.mjs");
    chain = await verifyScienceEditChain(run, receipt);
  } else {
    const files = await readdir(run);
    const matches = [];
    for (const name of files.filter((n) =>
      /^scientist-attempt-[1-9]\d*\.json$/.test(n),
    )) {
      const original = await data(name);
      if (original.completionId !== receipt.authorCompletionId) continue;
      assert.equal(original.role, "scientist");
      assert.equal(original.provider, "deepseek");
      assert.equal(original.providerHost, receipt.providerHost);
      assert.equal(original.model, receipt.model);
      assert.equal(original.evidenceHash, receipt.evidenceHash);
      assert.equal(original.outputHash, hash(interpretation));
      assert.deepEqual(original.value, interpretation);
      assert.notEqual(original.requestHash, receipt.requestHash);
      const peer = name.replace("scientist-", "scientific-peer-");
      assert.deepEqual(await data(peer), receipt);
      matches.push(name, peer);
    }
    assert.equal(matches.length, 2);
    chain = {
      files: matches,
      completionIds: [receipt.authorCompletionId, receipt.completionId],
    };
  }
  assert(new Set(chain.completionIds).size === chain.completionIds.length);
  assert(
    chain.completionIds.includes(receipt.authorCompletionId) &&
      chain.completionIds.includes(receipt.completionId),
  );
  console.log(JSON.stringify(chain));
}
main().catch(() => {
  console.error("Material peer evidence or response binding failed.");
  process.exitCode = 1;
});
