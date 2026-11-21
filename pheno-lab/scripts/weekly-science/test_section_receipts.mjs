import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

const folder = await mkdtemp(join(tmpdir(), "synthetic-pheno-sections-"));
const write = (file, v) =>
  writeFile(join(folder, file), JSON.stringify(v), { mode: 0o600 });
const digest = (str) => createHash("sha256").update(str).digest("hex");
const hash = (data) =>
  digest(
    JSON.stringify(data, (_, v) =>
      !v || typeof v !== "object" || Array.isArray(v)
        ? v
        : Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, v[k]]),
          ),
    ),
  );
const fileHash = async (n) => digest(await readFile(join(folder, n)));
function model(role, evidence, input, value) {
  return {
    role,
    provider: "deepseek",
    model: "deepseek-v4-pro",
    providerHost: "api.deepseek.com",
    requestId: randomUUID(),
    completionId: randomUUID(),
    requestHash: hash(randomUUID()),
    promptHash: hash(role),
    evidenceHash: hash(evidence),
    inputHash: hash(input),
    outputHash: hash(value),
    value,
  };
}
const check = () =>
  spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./verify_section_receipts.mjs", import.meta.url)),
      folder,
    ],
    { encoding: "utf8" },
  );
try {
  const evidence = { test: true },
    candidate = { summary: "Synthetic result." },
    verdict = { decision: "PASS", findings: [] };
  const publicAuthor = model("author", evidence, { evidence }, candidate);
  const publicPeer = {
    ...model("reviewer", evidence, { evidence, draft: candidate }, verdict),
    reviewedManuscriptHash: hash(candidate),
  };
  await write("provider-packet.json", evidence);
  await write("manuscript-candidate.json", candidate);
  await write("author-attempt-1.json", publicAuthor);
  await write("public-model-review.json", publicPeer);
  await write("peer-attempt-1.json", publicPeer);
  const dossier = {
    projects: [
      {
        projectAlias: "demo",
        ledgerEntries: [],
        periodPerformance: {
          routeCohorts: [
            {
              routeId: "r",
              periodCohort: "current",
              view: "STRICT_RECORDED_PROTOCOL",
              evidenceTier: "SOURCE_LINKED_INSTRUMENT_SCAN",
              experimentCode: "sample",
              measurementAliases: ["m1"],
            },
          ],
        },
      },
    ],
  };
  await write("rd-dossier.json", dossier);
  await write("snapshot.json", { version: 1 });
  await write("bindings.private.json", {
    projects: { P1: { projectAlias: "demo" } },
  });
  const files = Object.fromEntries(
    await Promise.all(
      [
        "rd-dossier.json",
        "snapshot.json",
        "bindings.private.json",
        "provider-packet.json",
      ].map(async (n) => [n, await fileHash(n)]),
    ),
  );
  const src = {
    experimentCode: "sample",
    sourceHash: hash("fake"),
    routes: [{ routeId: "r", cohorts: [{ sourcePeriod: "current" }] }],
  };
  const project = { project: "P1", routeCases: [src] },
    intent = {
      experimentCode: "sample",
      sourceHash: src.sourceHash,
      purpose: "a",
      attainment: "b",
    };
  const judgment = {
    project: "P1",
    routeIntents: [intent],
    issueAssessments: [],
  };
  const a = model("project-author", project, { evidence: project }, judgment);
  const b = model(
    "project-reviewer",
    project,
    { evidence: project, candidate: judgment },
    verdict,
  );
  await write("project-source-packet.private.json", {
    files,
    projects: [project],
  });
  await write("project-decisions.json", { projects: [judgment] });
  const bundle = await fileHash("project-decisions.json");
  const pair = (a, b) => ({
    authorCompletionId: a.completionId,
    reviewerCompletionId: b.completionId,
    authorRequestHash: a.requestHash,
    reviewerRequestHash: b.requestHash,
    reviewDecision: "PASS",
    evidenceHash: a.evidenceHash,
  });
  await write("project-decisions-review.json", {
    files,
    decisionBundleSha256: bundle,
    projects: [
      {
        ...pair(a, b),
        project: "P1",
        outputHash: a.outputHash,
        issueBindings: [],
      },
    ],
  });
  const pfile = "project-attempt-" + a.requestId + ".json";
  await write(pfile, { author: a, reviewer: b });
  const data = {
    cases: [
      {
        key: "C1",
        source: src,
        reviewedPurpose: "a",
        reviewedAttainment: "b",
        comparisons: [
          {
            key: "V1",
            routeId: "r",
            sourcePeriod: "current",
            eligibleLinkedScans: 1,
          },
        ],
      },
    ],
  };
  const goal = {
    cases: [
      {
        key: "C1",
        evidenceKeys: ["V1"],
        goalBasis: "basis",
        reason: "reason",
        status: "state",
      },
    ],
  };
  const ga = model("goal-assessor", data, { evidence: data }, goal),
    gr = model(
      "goal-reviewer",
      data,
      { evidence: data, candidate: goal },
      verdict,
    );
  await write("purpose-assessment-attempt-" + ga.requestId + ".json", {
    author: ga,
    reviewer: gr,
  });
  const row = {
    project: "P1",
    experimentCode: "sample",
    sourceHash: src.sourceHash,
    goalBasis: "basis",
    reason: "reason",
    status: "state",
    evidenceIds: ["m1"],
  };
  const attainment = {
    ...pair(ga, gr),
    decisionBundleSha256: bundle,
    authorRequestId: ga.requestId,
    rows: [row],
  };
  await write("project-attainment.json", attainment);
  await write("report-document-candidate.json", candidate);
  await write("science-interpretation.json", {
    cases: [],
    followupAssessments: [],
  });
  await write("private-science-bindings.json", {});
  const chem = {
    completionId: randomUUID(),
    authorCompletionId: randomUUID(),
    outputHash: hash("value"),
    reviewedInterpretationHash: hash("interpretation"),
  };
  await write("independent-material-science-review.json", chem);
  await write("science-public-index.private.json", {
    cases: [],
    followupAssessments: [],
    publicDocumentAtAssembly: await fileHash("report-document-candidate.json"),
    privateInterpretationHash: chem.reviewedInterpretationHash,
    privateReviewOutcomeHash: chem.outputHash,
  });
  const passed = check();
  assert.equal(passed.status, 0, passed.stderr);
  assert(JSON.parse(passed.stdout).files.includes(pfile));
  await write("project-attainment.json", {
    ...attainment,
    rows: [{ ...row, evidenceIds: ["unreviewed"] }],
  });
  assert.notEqual(check().status, 0);
  await write("project-attainment.json", attainment);
  await write(pfile, {
    author: a,
    reviewer: { ...b, completionId: publicAuthor.completionId },
  });
  assert.notEqual(check().status, 0);
  console.log(
    "Section attestations bind source rows, actual roles and distinct requests.",
  );
} finally {
  await rm(folder, { recursive: true });
}
