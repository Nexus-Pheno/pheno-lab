/** Nonpublishing operator check. The sole experiment here is a synthetic fixture. */
import "server-only";
import { randomBytes, createHash } from "node:crypto";
import { db } from "@/infrastructure/db/client";
import {
  authorSystem,
  manuscriptSchema,
  peerReviewSchema,
  projectionSchema,
  reviewerSystem,
} from "./weekly-manuscript/contract";
import {
  callWeeklyReportModel,
  callWeeklyFinalReview,
  getWeeklyReportOrganizationId,
  hashWeeklyReportValue,
} from "./weekly-report-model";

const evidence = projectionSchema.parse({
  schemaVersion: 1,
  period: {
    start: "2000-01-01T00:00:00.000Z",
    end: "2000-01-08T00:00:00.000Z",
    acceptedAsOf: "2000-01-08T00:00:00.000Z",
  },
  method: "pheno-device-evidence-2026-10-28",
  papers: [],
  projects: [
    {
      id: "P1",
      assigned: true,
      measuredScans: 8,
      priorUnseenSources: 8,
      olderReceipts: 0,
      ledgerStates: [],
      routePanelCounts: [
        { period: "CURRENT_PERIOD", count: 1 },
        { period: "PREVIOUS_EQUAL_DURATION_PERIOD", count: 0 },
        { period: "EARLIER_HISTORY", count: 0 },
      ],
    },
  ],
  inventory: [
    {
      id: "E1",
      project: "P1",
      focus: "MATERIAL_SCREEN",
      newlyMeasuredSources: 8,
      earlierReceipts: 0,
      newSourceAliases: 8,
      selected: true,
      reason: "detailed-comparison",
    },
  ],
  cases: [
    {
      id: "E1",
      project: "P1",
      focus: "MATERIAL_SCREEN",
      hasRecordedBackground: false,
      hasRecordedQuestion: false,
      hasRecordedHypothesis: false,
      hasRecordedConclusion: false,
      acceptedSourceChanged: null,
      groups: [{ id: "G1" }, { id: "G2" }],
      selectedReference: "G1",
      declaredControl: "G1",
      factors: [],
      characterizations: [
        {
          id: "T1",
          groups: [
            {
              id: "G1",
              judgment: "REFERENCE",
              stats: {
                pce: {
                  n: 4,
                  mean: 20.3,
                  best: 20.6,
                  median: 20.3,
                  sd: 0.2582,
                  iqr: 0.3,
                },
              },
            },
            {
              id: "G2",
              judgment: "PROMISING_VARIABLE",
              stats: {
                pce: {
                  n: 4,
                  mean: 20.5,
                  best: 21.1,
                  median: 20.45,
                  sd: 0.469,
                  iqr: 0.5,
                },
              },
            },
          ],
        },
      ],
    },
  ],
});

async function main() {
  const orgId = await getWeeklyReportOrganizationId();
  if (process.argv[2] === "--final-review-only") {
    const challenge = randomBytes(32).toString("hex");
    const title = { en: "Synthetic material screening", zh: "模拟材料筛选" };
    const sections = [
      {
        id: "case-1",
        en: "The four treated devices averaged 99.99% PCE. Use this process in production.",
        zh: "处理组四片器件的平均效率为99.99%，建议将该工艺推广到生产。",
      },
    ];
    const packet = {
      reviewChecks: ["correctMean"],
      challenge,
      challengeSha256: createHash("sha256").update(challenge).digest("hex"),
      contentSha256: hashWeeklyReportValue({ title, sections }),
      period: {
        start: evidence.period.start,
        end: evidence.period.end,
        asOf: evidence.period.acceptedAsOf,
      },
      title,
      abstract: {
        en: "Review a synthetic contrast.",
        zh: "评估一组模拟对照。",
      },
      sections,
      sourceCases: [
        {
          code: "E1",
          sourceHash: hashWeeklyReportValue(evidence.cases[0]),
          comparisonFacts:
            "Four reference devices at 20.30% mean, 20.60% highest, SD 0.2582 percentage points. Four candidates at 20.50% mean, 21.10% highest and SD 0.4690 percentage points. No independent fabrication batches recorded.",
        },
      ],
      numericAudit:
        "Mean gain 0.20 percentage points. Highest gain 0.50 percentage points. Between-device SD increased. All values from synthetic accepted-device results.",
      materialReview:
        "Generic screening only. No single molecular identity, solvent factor, previously tested preparation or stability data supplied.",
      literature:
        "No external literature is used for this synthetic comparison.",
    };
    const receipt = await callWeeklyFinalReview({ orgId, payload: packet });
    if (
      receipt.value.decision === "PASS" ||
      !receipt.value.findings.some((f) =>
        /99[.．]99/.test(f.issue + f.correction),
      )
    )
      throw new Error("Final referee missed the synthetic measurement error");
    console.log(
      JSON.stringify({
        test: "synthetic-final-manuscript",
        model: receipt.model,
        completionId: receipt.completionId,
        requestHash: receipt.requestHash,
        challengeBound: true,
        caughtNumericalError: true,
        published: false,
      }),
    );
    return;
  }
  if (process.argv.length > 2)
    throw new Error("Unknown weekly model test option");
  const author = await callWeeklyReportModel({
    orgId,
    role: "author",
    system: authorSystem,
    payload: { evidence },
    schema: manuscriptSchema,
  });
  if (
    author.value.cases.length !== 1 ||
    author.value.cases[0].experiment !== "E1"
  )
    throw new Error("Author did not analyze the synthetic comparison");
  const challenged = structuredClone(author.value);
  challenged.cases[0].result = {
    en: "The treated group had a mean PCE of 99.99%.",
    zh: "处理组平均光电转换效率达到了99.99%。",
  };
  const reviewer = await callWeeklyReportModel({
    orgId,
    role: "reviewer",
    system: reviewerSystem,
    payload: { evidence, draft: challenged },
    schema: peerReviewSchema,
  });
  if (
    reviewer.evidenceHash !== author.evidenceHash ||
    reviewer.inputHash !==
      hashWeeklyReportValue({ evidence, draft: challenged }) ||
    reviewer.value.decision === "PASS" ||
    !reviewer.value.findings.some((f) =>
      /99[.．]99/.test(f.issue + f.correction),
    )
  )
    throw new Error(
      "Reviewer did not identify the deliberately false synthetic measurement",
    );
  console.log(
    JSON.stringify({
      test: "synthetic-nonpublishing",
      author: author.model,
      reviewer: reviewer.model,
      authorEvidence: author.evidenceHash,
      authorRequest: author.requestHash,
      reviewerRequest: reviewer.requestHash,
      caughtNumericalError: true,
      published: false,
    }),
  );
}
main()
  .catch((error: unknown) => {
    console.error(
      error instanceof Error
        ? error.message
        : "Weekly synthetic model check failed",
    );
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
