import assert from "node:assert/strict";
import { verifyProjectAuthorship } from "../weekly-report-model-project-edits.mjs";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hash = (value) =>
  sha(
    JSON.stringify(value, (_, v) =>
      !v || typeof v !== "object" || Array.isArray(v)
        ? v
        : Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, v[k]]),
          ),
    ),
  );
const fingerprint = /^[a-f0-9]{64}$/;
const request = /^[a-f0-9-]{36}$/;

async function main() {
  const root = process.argv[2];
  const sealed = new Set();
  async function data(file, seal = true) {
    assert.equal(file, basename(file));
    const p = join(root, file);
    const st = await lstat(p);
    assert(
      st.isFile() &&
        st.uid === process.getuid() &&
        st.nlink === 1 &&
        !(st.mode & 0o077) &&
        st.size <= 512 * 1024 * 1024,
    );
    if (seal) sealed.add(file);
    return JSON.parse(await readFile(p, "utf8"));
  }
  const names = await readdir(root);
  const seen = new Set();
  const completion = (r, role) => {
    assert.equal(r.role, role);
    assert.equal(r.model, "deepseek-v4-pro");
    assert.equal(r.providerHost, "api.deepseek.com");
    assert.equal(r.provider, "deepseek");
    assert.equal(r.outputHash, hash(r.value));
    for (const k of ["requestHash", "evidenceHash", "inputHash", "promptHash"])
      assert(fingerprint.test(r[k]));
    assert(request.test(r.requestId));
    assert(
      typeof r.completionId === "string" &&
        r.completionId.length > 0 &&
        !seen.has(r.completionId),
    );
    seen.add(r.completionId);
  };
  function pass(r) {
    assert.equal(r.value.decision, "PASS");
    assert(r.value.findings.every((f) => f.severity !== "blocking"));
  }
  const evidence = await data("provider-packet.json");
  const candidate = await data("manuscript-candidate.json");
  const review = await data("public-model-review.json");
  completion(review, "reviewer");
  pass(review);
  assert.equal(review.evidenceHash, hash(evidence));
  assert.equal(review.reviewedManuscriptHash, hash(candidate));
  assert.equal(review.inputHash, hash({ evidence, draft: candidate }));
  let accepted = 0;
  for (const n of names.filter((n) => /^author-attempt-\d+\.json$/.test(n))) {
    const author = await data(n, false);
    if (author.outputHash !== review.reviewedManuscriptHash) continue;
    const peerName = n.replace("author-", "peer-");
    if (!names.includes(peerName)) continue;
    const peer = await data(peerName, false);
    if (peer.completionId !== review.completionId) continue;
    assert.deepEqual(peer, review);
    completion(author, "author");
    assert.equal(author.evidenceHash, review.evidenceHash);
    assert.notEqual(review.requestHash, author.requestHash);
    sealed.add(n);
    sealed.add(peerName);
    accepted++;
  }
  assert.equal(accepted, 1);
  const projects = await data("project-source-packet.private.json");
  const bundle = await data("project-decisions.json");
  const summary = await data("project-decisions-review.json");
  assert.deepEqual(summary.files, projects.files);
  for (const n of [
    "snapshot.json",
    "rd-dossier.json",
    "bindings.private.json",
    "provider-packet.json",
  ]) {
    assert.equal(summary.files[n], sha(await readFile(join(root, n))));
    sealed.add(n);
  }
  assert.equal(
    summary.decisionBundleSha256,
    sha(await readFile(join(root, "project-decisions.json"))),
  );
  assert.deepEqual(
    projects.projects.map((v) => v.project),
    bundle.projects.map((v) => v.project),
  );
  assert.deepEqual(
    projects.projects.map((v) => v.project),
    summary.projects.map((v) => v.project),
  );
  const dossier = await data("rd-dossier.json");
  const binds = await data("bindings.private.json");
  const pool = new Map();
  for (const file of names.filter((n) =>
    /^project-attempt-[a-f0-9-]+\.json$/.test(n),
  )) {
    const attempt = await data(file, false);
    assert(!pool.has(attempt.author.completionId));
    pool.set(attempt.author.completionId, { file, attempt });
  }
  for (const [i, meta] of summary.projects.entries()) {
    const e = projects.projects[i],
      c = bundle.projects[i];
    const { file, attempt } = pool.get(meta.authorCompletionId);
    const { author, reviewer } = attempt;
    verifyProjectAuthorship(attempt, e, pool, {
      hash,
      completion,
      seal: (name) => sealed.add(name),
    });
    completion(reviewer, "project-reviewer");
    pass(reviewer);
    sealed.add(file);
    const project = dossier.projects.find(
      (item) => item.projectAlias === binds.projects[e.project].projectAlias,
    );
    assert(
      project && project.ledgerEntries.length === c.issueAssessments.length,
    );
    assert.deepEqual(
      meta.issueBindings,
      c.issueAssessments.map((issue, index) => ({
        key: issue.key,
        entryId: project.ledgerEntries[index].entryId,
      })),
    );
    assert.equal(meta.reviewDecision, "PASS");
    assert.equal(meta.evidenceHash, hash(e));
    assert.equal(meta.outputHash, hash(c));
    assert.equal(author.outputHash, meta.outputHash);
    assert.equal(author.evidenceHash, meta.evidenceHash);
    assert.equal(reviewer.evidenceHash, meta.evidenceHash);
    assert.equal(reviewer.inputHash, hash({ evidence: e, candidate: c }));
    assert.equal(meta.authorRequestHash, author.requestHash);
    assert.equal(meta.reviewerRequestHash, reviewer.requestHash);
    assert.equal(meta.reviewerCompletionId, reviewer.completionId);
    assert.notEqual(author.requestHash, reviewer.requestHash);
  }

  const goal = await data("project-attainment.json");
  const blinded = await data("purpose-reviewed.private.json");
  for (const k of [
    "authorRequestId",
    "authorCompletionId",
    "reviewerCompletionId",
    "evidenceHash",
  ])
    assert.equal(blinded[k], goal[k]);
  assert(request.test(goal.authorRequestId));
  const { author, reviewer } = await data(
    "purpose-assessment-attempt-" + goal.authorRequestId + ".json",
  );
  completion(author, "goal-assessor");
  completion(reviewer, "goal-reviewer");
  pass(reviewer);
  assert.equal(goal.reviewDecision, "PASS");
  assert.equal(goal.decisionBundleSha256, summary.decisionBundleSha256);
  assert.equal(goal.authorRequestId, author.requestId);
  assert.equal(goal.authorCompletionId, author.completionId);
  assert.equal(goal.reviewerCompletionId, reviewer.completionId);
  assert.equal(goal.authorRequestHash, author.requestHash);
  assert.equal(goal.reviewerRequestHash, reviewer.requestHash);
  assert.notEqual(author.requestHash, reviewer.requestHash);

  const route = new Map(
    dossier.projects.flatMap((p) =>
      p.periodPerformance.routeCohorts
        .filter(
          (c) =>
            c.view === "STRICT_RECORDED_PROTOCOL" &&
            c.evidenceTier === "SOURCE_LINKED_INSTRUMENT_SCAN",
        )
        .map((c) => [
          [c.experimentCode, c.routeId, c.periodCohort].join("|"),
          c.measurementAliases,
        ]),
    ),
  );
  const cases = [],
    rows = [];
  for (const [i, proj] of projects.projects.entries()) {
    for (const [j, src] of proj.routeCases.entries()) {
      const intent = bundle.projects[i].routeIntents[j];
      assert.equal(src.sourceHash, intent.sourceHash);
      assert.equal(src.experimentCode, intent.experimentCode);
      const measures = new Map(),
        key = "C" + (cases.length + 1);
      const comparisons = src.routes.flatMap((r) =>
        r.cohorts.map((c) => {
          const k = "V" + (measures.size + 1);
          const aliases =
            route.get(
              [src.experimentCode, r.routeId, c.sourcePeriod].join("|"),
            ) ?? [];
          measures.set(k, aliases);
          return {
            key: k,
            routeId: r.routeId,
            sourcePeriod: c.sourcePeriod,
            eligibleLinkedScans: aliases.length,
          };
        }),
      );
      cases.push({
        key,
        source: src,
        comparisons,
      });
      const assessment = author.value.cases[rows.length];
      assert.equal(assessment.key, key);
      const evidenceIds = [
        ...new Set(
          assessment.evidenceKeys.map((k) => {
            const aliases = measures.get(k);
            assert(aliases?.length);
            return aliases[0];
          }),
        ),
      ];
      rows.push({
        project: proj.project,
        experimentCode: src.experimentCode,
        sourceHash: src.sourceHash,
        status: assessment.status,
        goalBasis: assessment.goalBasis,
        reason: assessment.reason,
        evidenceIds,
      });
    }
  }
  assert.deepEqual(rows, goal.rows);
  assert.equal(author.value.cases.length, cases.length);
  assert.equal(goal.evidenceHash, hash({ cases }));
  assert.equal(author.evidenceHash, goal.evidenceHash);
  assert.equal(reviewer.evidenceHash, goal.evidenceHash);
  assert.equal(
    reviewer.inputHash,
    hash({ evidence: { cases }, candidate: author.value }),
  );

  const scientific = await data("science-public-index.private.json");
  const science = await data("science-interpretation.json");
  const privateBindings = await data("private-science-bindings.json");
  assert.deepEqual(
    scientific.cases.map((item) => item.case),
    science.cases.map((item) => item.experiment),
  );
  for (const [i, paper] of scientific.cases.entries()) {
    const reviewed = science.cases[i],
      bound = binds.cases[paper.case];
    assert.deepEqual(paper.public, reviewed.public);
    assert.equal(paper.binding.experimentCode, bound.code);
    assert.equal(paper.binding.sourceHash, reviewed.sourceHash);
    assert.equal(bound.sourceHash, reviewed.sourceHash);
    assert.equal(paper.binding.asOf, evidence.period.acceptedAsOf);
    assert.equal(paper.binding.policy, "accepted-device-result-v1");
    assert.equal(
      paper.binding.characterizationId,
      bound.characterizations[reviewed.characterization],
    );
    assert.deepEqual(
      paper.binding.groupLabels,
      [reviewed.reference, reviewed.comparator]
        .filter(Boolean)
        .map((key) => bound.groups[key]),
    );
    assert.equal(paper.sectionId, "case-" + reviewed.experiment.toLowerCase());
    assert.equal(
      paper.testSectionId,
      "test-" + reviewed.experiment.toLowerCase(),
    );
  }
  assert.deepEqual(
    scientific.followupAssessments,
    science.followupAssessments.map((item) => {
      assert(privateBindings[item.experiment].ledger[item.id]);
      return { ...item, ...privateBindings[item.experiment].ledger[item.id] };
    }),
  );
  const material = await data("independent-material-science-review.json");
  assert(
    !seen.has(material.completionId) && !seen.has(material.authorCompletionId),
  );
  assert.equal(scientific.privateReviewOutcomeHash, material.outputHash);
  assert.equal(
    scientific.privateInterpretationHash,
    material.reviewedInterpretationHash,
  );
  await data("report-document-candidate.json");
  assert.equal(
    scientific.publicDocumentAtAssembly,
    sha(await readFile(join(root, "report-document-candidate.json"))),
  );
  console.log(
    JSON.stringify({
      files: [...sealed].sort(),
      completionIds: [
        ...seen,
        material.authorCompletionId,
        material.completionId,
      ],
    }),
  );
}
main().catch(() => {
  console.error(
    "Section reviews, authentic completions or their exact scientific sources did not reconcile.",
  );
  process.exitCode = 1;
});
