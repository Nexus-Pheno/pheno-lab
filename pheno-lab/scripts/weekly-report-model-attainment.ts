import "server-only";
import { db } from "@/infrastructure/db/client";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  callWeeklyGoalReview,
  getWeeklyReportOrganizationId,
  hashWeeklyReportValue,
} from "./weekly-report-model";
import { fileHash, immutable } from "./weekly-report-model-projects";
import {
  projectEvidenceSchema,
  projectJudgmentSchema,
  goalEvidenceSchema,
  goalJudgmentSchema,
  projectCritiqueSchema,
} from "./weekly-report-model-project-contract";

const row = z.object({
  experimentCode: z.string(),
  routeId: z.string(),
  periodCohort: z.string(),
  view: z.string(),
  evidenceTier: z.string(),
  measurementAliases: z.array(z.string()),
});
const indexes = z.object({
  projects: z.array(
    z.object({ periodPerformance: z.object({ routeCohorts: z.array(row) }) }),
  ),
});
type E = z.output<typeof goalEvidenceSchema>;
type A = z.output<typeof goalJudgmentSchema>;
export function checkGoalEvidence(e: E, candidate: A) {
  if (e.cases.length !== candidate.cases.length)
    throw Error("Goal coverage differs");
  for (const [i, source] of e.cases.entries()) {
    const actual = candidate.cases[i];
    const measured = new Set(
      source.comparisons
        .filter((c) => c.eligibleLinkedScans > 0)
        .map((c) => c.key),
    );
    if (
      actual.key !== source.key ||
      new Set(actual.evidenceKeys).size !== actual.evidenceKeys.length ||
      actual.evidenceKeys.some((k) => !measured.has(k))
    )
      throw Error("Purpose evidence not in the actual experiment");
    if (
      (actual.goalBasis === "NO_DOCUMENTED_GOAL") !==
      (actual.status === "NO_PRESPECIFIED_GOAL")
    )
      throw Error("Purpose status inconsistent with goal basis");
    if (
      actual.goalBasis === "REVIEWER_INTERPRETATION_OF_CURRENT_FIELDS" &&
      ![source.source.problem, source.source.hypothesis].some((v) =>
        v.replace(/<[^>]+>/g, "").trim(),
      )
    )
      throw Error("No recorded intent supports the purpose classification");
    if (
      ["ANSWERED", "PARTIAL"].includes(actual.status) &&
      !actual.evidenceKeys.length
    )
      throw Error("Answered purpose lacks source-linked measurements");
  }
}
async function main() {
  const parallelResearch = process.argv[3] === "--research-only";
  if (
    process.argv.length !== 3 &&
    !(process.argv.length === 4 && parallelResearch)
  )
    throw Error("Expected private report run directory");
  const dir = resolve(process.argv[2]);
  const load = async (f: string) =>
    JSON.parse(await readFile(join(dir, f), "utf8")) as unknown;
  const source = z
    .object({
      files: z.record(z.string(), z.string()),
      projects: z.array(projectEvidenceSchema),
    })
    .parse(await load("project-source-packet.private.json"));
  if (
    source.files["rd-dossier.json"] !==
    (await fileHash(join(dir, "rd-dossier.json")))
  )
    throw Error("Frozen purpose source changed");
  const d = indexes.parse(await load("rd-dossier.json"));
  const physical = new Map(
    d.projects.flatMap((p) =>
      p.periodPerformance.routeCohorts
        .filter(
          (r) =>
            r.view === "STRICT_RECORDED_PROTOCOL" &&
            r.evidenceTier === "SOURCE_LINKED_INSTRUMENT_SCAN",
        )
        .map(
          (r) =>
            [
              r.experimentCode + "|" + r.routeId + "|" + r.periodCohort,
              r.measurementAliases,
            ] as const,
        ),
    ),
  );
  const data: E = { cases: [] };
  const local = new Map<
    string,
    {
      project: string;
      experimentCode: string;
      sourceHash: string;
      measures: Map<string, string[]>;
    }
  >();
  for (const proj of source.projects) {
    for (const caseSource of proj.routeCases) {
      const caseKey = "C" + (data.cases.length + 1);
      const measures = new Map<string, string[]>();
      const comparisons = caseSource.routes.flatMap((r) =>
        r.cohorts.map((c) => {
          const key = "V" + (measures.size + 1);
          const list =
            physical.get(
              caseSource.experimentCode +
                "|" +
                r.routeId +
                "|" +
                c.sourcePeriod,
            ) ?? [];
          measures.set(key, list);
          return {
            key,
            routeId: r.routeId,
            sourcePeriod: c.sourcePeriod,
            eligibleLinkedScans: list.length,
          };
        }),
      );
      data.cases.push({
        key: caseKey,
        source: caseSource,
        comparisons,
      });
      local.set(caseKey, {
        project: proj.project,
        experimentCode: caseSource.experimentCode,
        sourceHash: caseSource.sourceHash,
        measures,
      });
    }
  }
  const markerSchema = z.object({
    authorRequestId: z.uuid(),
    authorCompletionId: z.string(),
    reviewerCompletionId: z.string(),
    evidenceHash: z.string(),
  });
  async function finish(saved: z.output<typeof markerSchema>) {
    const attempt = z
      .object({
        author: z.object({
          completionId: z.string(),
          value: goalJudgmentSchema,
          requestHash: z.string(),
          outputHash: z.string(),
          evidenceHash: z.string(),
        }),
        reviewer: z.object({
          completionId: z.string(),
          value: projectCritiqueSchema,
          inputHash: z.string(),
          requestHash: z.string(),
        }),
      })
      .parse(
        await load(
          "purpose-assessment-attempt-" + saved.authorRequestId + ".json",
        ),
      );
    const { author, reviewer } = attempt;
    if (
      saved.evidenceHash !== hashWeeklyReportValue(data) ||
      author.evidenceHash !== saved.evidenceHash ||
      author.outputHash !== hashWeeklyReportValue(author.value) ||
      author.completionId === reviewer.completionId ||
      saved.authorCompletionId !== author.completionId ||
      saved.reviewerCompletionId !== reviewer.completionId ||
      reviewer.value.decision !== "PASS" ||
      reviewer.value.findings.some((f) => f.severity === "blocking") ||
      reviewer.inputHash !==
        hashWeeklyReportValue({ evidence: data, candidate: author.value })
    )
      throw Error("Purpose assessment lacks matching scientific review");
    checkGoalEvidence(data, author.value);
    if (parallelResearch) {
      console.log(
        "Blinded purpose review passed for " +
          author.value.cases.length +
          " experiments.",
      );
      return;
    }
    const decisions = z
      .object({ projects: z.array(projectJudgmentSchema) })
      .parse(await load("project-decisions.json"));
    const meta = z
      .object({
        files: z.record(z.string(), z.string()),
        decisionBundleSha256: z.string(),
        projects: z.array(
          z.object({
            project: z.string(),
            evidenceHash: z.string(),
            outputHash: z.string(),
            reviewDecision: z.literal("PASS"),
          }),
        ),
      })
      .parse(await load("project-decisions-review.json"));
    if (
      meta.decisionBundleSha256 !==
        (await fileHash(join(dir, "project-decisions.json"))) ||
      hashWeeklyReportValue(meta.files) !==
        hashWeeklyReportValue(source.files) ||
      meta.files["rd-dossier.json"] !==
        (await fileHash(join(dir, "rd-dossier.json")))
    )
      throw Error("Previously reviewed project sources changed");
    for (const [i, proj] of source.projects.entries()) {
      const seen = decisions.projects[i],
        receipt = meta.projects[i];
      if (
        proj.project !== seen.project ||
        receipt.project !== proj.project ||
        hashWeeklyReportValue(proj) !== receipt.evidenceHash ||
        hashWeeklyReportValue(seen) !== receipt.outputHash
      )
        throw Error("Referred project judgments lack source-linked approval");
      for (const [j, caseSource] of proj.routeCases.entries()) {
        const intent = seen.routeIntents[j];
        if (
          intent.experimentCode !== caseSource.experimentCode ||
          intent.sourceHash !== caseSource.sourceHash
        )
          throw Error("Project experiment binding changed");
      }
    }
    const rows = author.value.cases.map((c) => {
      const l = local.get(c.key)!;
      const evidenceIds = Array.from(
        new Set(c.evidenceKeys.map((k) => l.measures.get(k)![0])),
      );
      return {
        project: l.project,
        experimentCode: l.experimentCode,
        sourceHash: l.sourceHash,
        status: c.status,
        goalBasis: c.goalBasis,
        reason: c.reason,
        evidenceIds,
      };
    });
    await immutable(join(dir, "project-attainment.json"), {
      schemaVersion: 1,
      decisionBundleSha256: meta.decisionBundleSha256,
      evidenceHash: author.evidenceHash,
      authorRequestId: saved.authorRequestId,
      authorCompletionId: author.completionId,
      reviewerCompletionId: reviewer.completionId,
      authorRequestHash: author.requestHash,
      reviewerRequestHash: reviewer.requestHash,
      reviewDecision: "PASS",
      rows,
    });
    console.log(
      "Bound " +
        rows.length +
        " independently reviewed experiment purposes to approved project decisions.",
    );
  }
  let saved: z.output<typeof markerSchema> | undefined;
  try {
    saved = markerSchema.parse(await load("purpose-reviewed.private.json"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (saved) {
    await finish(saved);
    return;
  }
  const orgId = await getWeeklyReportOrganizationId();
  let revision:
    { previous: A; review: z.output<typeof projectCritiqueSchema> } | undefined;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const author = await callWeeklyGoalReview({
      orgId,
      role: "goal-assessor",
      payload: { evidence: data, ...(revision ? { revision } : {}) },
    });
    const reviewer = await callWeeklyGoalReview({
      orgId,
      role: "goal-reviewer",
      payload: { evidence: data, candidate: author.value },
    });
    if (
      author.completionId === reviewer.completionId ||
      author.evidenceHash !== hashWeeklyReportValue(data) ||
      reviewer.evidenceHash !== author.evidenceHash ||
      reviewer.inputHash !==
        hashWeeklyReportValue({ evidence: data, candidate: author.value })
    )
      throw Error(
        "Purpose referee not bound to complete actual purpose appraisal",
      );
    let critique = reviewer.value;
    try {
      checkGoalEvidence(data, author.value);
    } catch (e) {
      critique = {
        ...critique,
        decision: "REVISE",
        findings: [
          ...critique.findings.slice(0, 15),
          {
            severity: "blocking",
            issue:
              e instanceof Error ? e.message : "Invalid purpose classification",
            correction:
              "For each actual case, reconcile goalBasis and status and use only directly applicable measured V keys.",
          },
        ],
      };
    }
    await immutable(
      join(dir, "purpose-assessment-attempt-" + author.requestId + ".json"),
      { author, reviewer },
    );
    if (
      critique.decision === "PASS" &&
      !critique.findings.some((f) => f.severity === "blocking")
    ) {
      const marker = {
        authorRequestId: author.requestId,
        authorCompletionId: author.completionId,
        reviewerCompletionId: reviewer.completionId,
        evidenceHash: author.evidenceHash,
      };
      await immutable(join(dir, "purpose-reviewed.private.json"), marker);
      await finish(marker);
      return;
    }
    if (critique.decision === "BLOCK" || !critique.findings.length) break;
    revision = { previous: author.value, review: critique };
  }
  throw Error("Final project purpose appraisals require further review");
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main()
    .catch((e) => {
      console.error(
        e instanceof Error && !("issues" in e)
          ? e.message
          : "Project purpose contract mismatch",
      );
      process.exitCode = 1;
    })
    .finally(() => db.$disconnect());
}
