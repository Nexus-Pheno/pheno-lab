/** Nonpublishing operator check. The sole experiment here is a synthetic fixture. */
import "server-only";
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
