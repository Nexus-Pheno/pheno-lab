import "server-only";
import { db } from "@/infrastructure/db/client";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  link,
  readdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  callWeeklyProjectReview,
  getWeeklyReportOrganizationId,
  hashWeeklyReportValue,
} from "./weekly-report-model";
import {
  projectEvidenceSchema,
  projectJudgmentSchema,
  projectCritiqueSchema,
} from "./weekly-report-model-project-contract";

const string = z.string();
const nullableNumber = z.number().nullable();
const n = z.number().int().nonnegative();
const nullableText = string.nullish();
const objMetric = z.object({
  nSamples: n,
  mean: nullableNumber,
  median: nullableNumber,
  iqr: nullableNumber,
  sampleStandardDeviation: nullableNumber,
});
const extremum = z.object({ pce: z.number() }).nullable();
const period = z.enum([
  "CURRENT_PERIOD",
  "PREVIOUS_EQUAL_DURATION_PERIOD",
  "EARLIER_HISTORY",
]);
const windows = period.options;
const rowSchema = z.object({
  view: string,
  routeId: string,
  periodCohort: period,
  experimentCode: string,
  group: nullableText,
  direction: nullableText,
  comparabilityIssues: z.array(string),
  inferenceOutcomes: z.object({
    nSamples: n,
    metrics: z.object({ pce: objMetric }),
  }),
  pceExtremes: z.object({
    championValidScan: extremum,
    bestPhysicalSampleMedian: extremum,
  }),
});
const experimentSchema = z.object({
  experimentCode: string,
  title: nullableText,
  observation: nullableText,
  problem: nullableText,
  hypothesis: nullableText,
  conclusion: nullableText,
});
const ledgerSchema = z.object({
  entryId: string,
  statement: string,
  status: string,
  history: z.array(z.object({ decisionNote: nullableText })),
});
const sourceProject = z.object({
  projectAlias: nullableText,
  projectName: nullableText,
  assigned: z.boolean(),
  experiments: z.array(experimentSchema),
  ledgerEntries: z.array(ledgerSchema),
  periodPerformance: z.object({ routeCohorts: z.array(rowSchema) }),
});
const primaryMetric = z.object({
  n,
  mean: nullableNumber,
  best: nullableNumber,
  sd: nullableNumber,
});
const primary = z.object({
  sourceHash: string,
  reference: z.object({ selectedGroup: nullableText }),
  characterizations: z.array(
    z.object({
      id: string,
      name: nullableText,
      groups: z.array(
        z.object({
          label: string,
          metrics: z.object({
            pce: primaryMetric.nullish().transform((m) => m ?? undefined),
            voc: primaryMetric.nullish().transform((m) => m ?? undefined),
            jsc: primaryMetric.nullish().transform((m) => m ?? undefined),
            ff: primaryMetric.nullish().transform((m) => m ?? undefined),
          }),
        }),
      ),
    }),
  ),
});
const dossierSchema = z.object({
  projects: z.array(sourceProject),
  primaryExperimentEvidence: z.object({
    experiments: z.array(
      z.object({ experimentCode: string, evidence: primary }),
    ),
  }),
});
const bindingsSchema = z.object({
  projects: z.record(string, z.object({ projectAlias: nullableText })),
  cases: z.record(string, z.object({ code: string, scope: string })),
});
const packetSchema = z.object({
  projects: z.array(
    z.object({
      id: string,
      assigned: z.boolean(),
      measuredScans: n,
      olderReceipts: n,
      priorUnseenSources: n,
    }),
  ),
});
type Project = z.output<typeof sourceProject>;
type Row = z.output<typeof rowSchema>;
type Approval = z.output<typeof projectJudgmentSchema>;
type Evidence = z.output<typeof projectEvidenceSchema>;
const clean = (s: string | null | undefined) =>
  (s ?? "").replace(
    /https?:\/\/\S+|[A-Z0-9_.+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?<!\w)c[a-z0-9]{22,30}(?!\w)|(?<!\d)1[3-9]\d{9}(?!\d)/gi,
    "[contact omitted]",
  );

export function projectEvidence(
  project: Project,
  summary: z.output<typeof packetSchema>["projects"][number],
  primaryMap: Map<string, z.output<typeof primary>>,
  detailed: Set<string>,
): Evidence {
  const rows = project.periodPerformance.routeCohorts.filter(
    (r) => r.view === "STRICT_RECORDED_PROTOCOL",
  );
  const grouped = new Map<string, Row[]>();
  for (const r of rows) {
    const group = grouped.get(r.routeId) ?? [];
    group.push(r);
    grouped.set(r.routeId, group);
  }
  const eligible = Array.from(grouped.values()).filter((rr) =>
    rr.some((r) => r.inferenceOutcomes.metrics.pce.nSamples > 0),
  );
  const cohortRank = (r: Row[]) =>
    Math.min(
      ...r
        .filter((x) => x.inferenceOutcomes.metrics.pce.nSamples > 0)
        .map((x) => windows.indexOf(x.periodCohort)),
    );
  // Prefer a measured recent window, exact historical comparators and coverage.
  // The sort never uses performance magnitude or a champion.
  const rank = (a: Row[], b: Row[]) =>
    cohortRank(a) - cohortRank(b) ||
    b.filter((r) => r.inferenceOutcomes.metrics.pce.nSamples > 0).length -
      a.filter((r) => r.inferenceOutcomes.metrics.pce.nSamples > 0).length ||
    Math.max(...b.map((r) => r.inferenceOutcomes.metrics.pce.nSamples)) -
      Math.max(...a.map((r) => r.inferenceOutcomes.metrics.pce.nSamples)) ||
    a[0].routeId.localeCompare(b[0].routeId);
  eligible.sort(rank);
  const codes = new Set<string>();
  for (const w of windows) {
    const choices = eligible.filter(
      (rs) =>
        rs.some(
          (r) =>
            r.periodCohort === w &&
            r.inferenceOutcomes.metrics.pce.nSamples > 0,
        ) && !codes.has(rs[0].experimentCode),
    );
    const route =
      choices.find((rs) => !detailed.has(rs[0].experimentCode)) ?? choices[0];
    if (route) codes.add(route[0].experimentCode);
  }
  const routeCases = Array.from(codes).map((code) => {
    const ex = project.experiments.find((x) => x.experimentCode === code);
    if (!ex) throw new Error("Project route has no experiment relation");
    const app = primaryMap.get(code);
    const routes = eligible
      .filter((rs) => rs[0].experimentCode === code)
      .slice(0, 3);
    const record = routes[0].find(
      (r) => windows.indexOf(r.periodCohort) === cohortRank(routes[0]),
    )!;
    const condensed = routes.map((rs) => ({
      routeId: rs[0].routeId,
      group: clean(rs[0].group),
      direction: clean(rs[0].direction),
      issues: Array.from(new Set(rs.flatMap((r) => r.comparabilityIssues))),
      cohorts: rs.map((r) => {
        const m = r.inferenceOutcomes.metrics.pce;
        return {
          sourcePeriod: r.periodCohort,
          nSamples: m.nSamples,
          mean: m.mean,
          median: m.median,
          sd: m.sampleStandardDeviation,
          iqr: m.iqr,
          championScan: r.pceExtremes.championValidScan?.pce ?? null,
          bestSampleMedian: r.pceExtremes.bestPhysicalSampleMedian?.pce ?? null,
        };
      }),
    }));
    return {
      experimentCode: code,
      sourceHash:
        app?.sourceHash ??
        hashWeeklyReportValue({ experiment: ex, routes: condensed }),
      hashBasis: app ? "app-accepted" : "dossier-intent-route",
      representativeRouteId: record.routeId,
      sourcePeriod: record.periodCohort,
      name: clean(ex.title),
      observation: clean(ex.observation),
      problem: clean(ex.problem),
      hypothesis: clean(ex.hypothesis),
      conclusion: clean(ex.conclusion),
      routes: condensed,
      currentAccepted:
        app?.characterizations.map((ch) => ({
          characterization: clean(ch.name) || "Unnamed characterization",
          reference:
            app.reference.selectedGroup == null
              ? null
              : clean(app.reference.selectedGroup),
          groups: ch.groups.map((g) => ({
            group: clean(g.label),
            stats: g.metrics,
          })),
        })) ?? [],
    };
  });
  return projectEvidenceSchema.parse({
    project: summary.id,
    name: clean(project.projectName),
    assigned: project.assigned,
    measuredScans: summary.measuredScans,
    earlierReceipts: summary.olderReceipts,
    firstSeenSources: summary.priorUnseenSources,
    scope: {
      experimentCount: project.experiments.length,
      routeCount: grouped.size,
      eligibleRouteCount: eligible.length,
      representedRouteCount: routeCases.reduce(
        (k, x) => k + x.routes.length,
        0,
      ),
      selectedExperiments: routeCases.length,
    },
    priorIssues: project.ledgerEntries.map((l, i) => ({
      key: "L" + (i + 1),
      statement: clean(l.statement),
      status: l.status,
      previousDecision: clean(l.history.at(-1)?.decisionNote),
    })),
    routeCases,
  });
}

function checkBindings(e: Evidence, x: Approval) {
  if (e.project !== x.project || e.routeCases.length !== x.routeIntents.length)
    throw new Error("Project decision coverage differs from source");
  if (
    e.priorIssues.length !== x.issueAssessments.length ||
    e.priorIssues.some((v, i) => v.key !== x.issueAssessments[i].key)
  )
    throw new Error("Prior issue coverage differs from the frozen ledger");
  const codes = new Set(e.routeCases.map((c) => c.experimentCode));
  const fresh = new Set(
    e.routeCases
      .filter((c) =>
        c.routes.some((r) =>
          r.cohorts.some(
            (v) => v.sourcePeriod === "CURRENT_PERIOD" && v.nSamples > 0,
          ),
        ),
      )
      .map((c) => c.experimentCode),
  );
  for (const issue of x.issueAssessments) {
    if (
      issue.testedExperimentCodes.some((code) => !codes.has(code)) ||
      (issue.assessment !== "no-new-direct-test" &&
        (!issue.testedExperimentCodes.length ||
          issue.testedExperimentCodes.some((code) => !fresh.has(code)))) ||
      (issue.assessment === "no-new-direct-test" &&
        issue.testedExperimentCodes.length)
    )
      throw new Error("Prior issue has no bound current direct test");
  }
  for (let i = 0; i < e.routeCases.length; i++) {
    const a = e.routeCases[i],
      b = x.routeIntents[i];
    if (
      (
        [
          "experimentCode",
          "sourceHash",
          "hashBasis",
          "representativeRouteId",
          "sourcePeriod",
        ] as const
      ).some((k) => a[k] !== b[k])
    )
      throw new Error(
        "Project decision references a different experiment or route",
      );
  }
}

export async function fileHash(path: string) {
  const hash = createHash("sha256");
  for await (const block of createReadStream(path)) hash.update(block);
  return hash.digest("hex");
}
export async function immutable(path: string, obj: unknown) {
  const text = JSON.stringify(obj, null, 2) + "\n",
    temp = path + "." + randomUUID();
  await writeFile(temp, text, { flag: "wx", mode: 0o600 });
  try {
    await link(temp, path);
  } catch (err) {
    if (
      (err as NodeJS.ErrnoException).code !== "EEXIST" ||
      (await readFile(path, "utf8")) !== text
    )
      throw err;
  } finally {
    await unlink(temp);
  }
  return createHash("sha256").update(text).digest("hex");
}
async function existing(path: string) {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return undefined;
  }
}
const receiptSchema = z.object({
  project: string,
  evidenceHash: string,
  outputHash: string,
  authorCompletionId: string,
  reviewerCompletionId: string,
  reviewDecision: z.literal("PASS"),
  authorRequestHash: string,
  reviewerRequestHash: string,
});
async function reviewOne(dir: string, orgId: string, e: Evidence) {
  const eh = hashWeeklyReportValue(e);
  const path = join(dir, "project-" + e.project + "-" + eh + ".json");
  const attemptFiles = await Promise.all(
    (await readdir(dir))
      .filter((n) => /^project-attempt-[a-f\d-]+\.json$/.test(n))
      .map(async (n) => ({
        p: join(dir, n),
        time: (await stat(join(dir, n))).mtimeMs,
      })),
  );
  attemptFiles.sort((a, b) => b.time - a.time);
  const history = [];
  for (const item of attemptFiles) {
    const envelope = z
      .object({
        author: z.object({
          evidenceHash: z.string(),
          outputHash: z.string(),
          completionId: z.string(),
          requestHash: z.string(),
          value: z.unknown(),
        }),
        reviewer: z.object({
          evidenceHash: z.string(),
          inputHash: z.string(),
          completionId: z.string(),
          requestHash: z.string(),
          value: z.unknown(),
        }),
      })
      .parse(await existing(item.p));
    if (envelope.author.evidenceHash !== eh) continue;
    const previous = projectJudgmentSchema.parse(envelope.author.value),
      review = projectCritiqueSchema.parse(envelope.reviewer.value);
    if (
      envelope.reviewer.evidenceHash !== eh ||
      envelope.author.outputHash !== hashWeeklyReportValue(previous) ||
      envelope.reviewer.inputHash !==
        hashWeeklyReportValue({ evidence: e, candidate: previous }) ||
      envelope.author.completionId === envelope.reviewer.completionId
    )
      throw new Error("Invalid saved project review");
    history.push({ envelope, previous, review });
  }
  const saved = await existing(path);
  if (saved !== undefined) {
    const o = z
      .object({ row: projectJudgmentSchema, receipt: receiptSchema })
      .parse(saved);
    checkBindings(e, o.row);
    if (
      o.receipt.project !== e.project ||
      o.receipt.evidenceHash !== eh ||
      o.receipt.outputHash !== hashWeeklyReportValue(o.row) ||
      o.receipt.authorCompletionId === o.receipt.reviewerCompletionId
    )
      throw new Error("Project checkpoint differs from evidence");
    if (
      !history.some(
        (h) =>
          h.review.decision === "PASS" &&
          !h.review.findings.some((f) => f.severity === "blocking") &&
          h.envelope.author.requestHash === o.receipt.authorRequestHash &&
          h.envelope.reviewer.requestHash === o.receipt.reviewerRequestHash &&
          h.envelope.author.completionId === o.receipt.authorCompletionId &&
          h.envelope.reviewer.completionId === o.receipt.reviewerCompletionId &&
          h.envelope.author.outputHash === o.receipt.outputHash,
      )
    )
      throw new Error(
        "Verified project decision requires its actual completed peer review",
      );
    return o;
  }
  let revision:
    | { previous: Approval; review: z.output<typeof projectCritiqueSchema> }
    | undefined;
  if (history[0]?.review.decision === "REVISE")
    revision = { previous: history[0].previous, review: history[0].review };
  for (let attempt = 0; attempt < 3; attempt++) {
    const w = await callWeeklyProjectReview({
      orgId,
      role: "project-author",
      payload: { evidence: e, ...(revision ? { revision } : {}) },
    });
    const r = await callWeeklyProjectReview({
      orgId,
      role: "project-reviewer",
      payload: { evidence: e, candidate: w.value },
    });
    if (
      w.completionId === r.completionId ||
      w.evidenceHash !== eh ||
      r.evidenceHash !== eh ||
      r.inputHash !== hashWeeklyReportValue({ evidence: e, candidate: w.value })
    )
      throw new Error("Project peer review binding differs");
    let corrected = r.value;
    try {
      checkBindings(e, w.value);
    } catch (error) {
      corrected = {
        ...r.value,
        decision: "REVISE",
        findings: [
          ...r.value.findings.slice(0, 15),
          {
            severity: "blocking",
            issue:
              error instanceof Error
                ? error.message
                : "Source bindings or inventory differ.",
            correction:
              "Return one entry per supplied case and prior issue in identical order. Copy binding fields exactly. Only cite genuinely matching current-period measured experiment codes for direct/partial prior-issue tests.",
          },
        ],
      };
    }
    await immutable(join(dir, "project-attempt-" + w.requestId + ".json"), {
      author: w,
      reviewer: r,
    });
    if (
      corrected.decision === "PASS" &&
      !corrected.findings.some((f) => f.severity === "blocking")
    ) {
      const result = {
        row: w.value,
        receipt: {
          project: e.project,
          evidenceHash: eh,
          outputHash: w.outputHash,
          authorCompletionId: w.completionId,
          reviewerCompletionId: r.completionId,
          reviewDecision: "PASS" as const,
          authorRequestHash: w.requestHash,
          reviewerRequestHash: r.requestHash,
        },
      };
      await immutable(path, result);
      return result;
    }
    if (corrected.decision === "BLOCK" || !corrected.findings.length) break;
    revision = { previous: w.value, review: corrected };
  }
  throw new Error(
    "Project " + e.project + " decision requires scientific review",
  );
}
async function main() {
  if (
    process.argv.length !== 3 &&
    !(
      process.argv.length === 4 &&
      ["--check-projection-only", "--save-projection-only"].includes(
        process.argv[3],
      )
    )
  )
    throw new Error("Expected private report run directory");
  const dir = resolve(process.argv[2]);
  const filesToHash = [
    "rd-dossier.json",
    "provider-packet.json",
    "bindings.private.json",
    "snapshot.json",
  ];
  const files = Object.fromEntries(
    await Promise.all(
      filesToHash.map(async (f) => [f, await fileHash(join(dir, f))]),
    ),
  );
  const load = async (f: string) =>
    JSON.parse(await readFile(join(dir, f), "utf8")) as unknown;
  const d = dossierSchema.parse(await load("rd-dossier.json")),
    packet = packetSchema.parse(await load("provider-packet.json")),
    bindings = bindingsSchema.parse(await load("bindings.private.json"));
  const byCode = new Map(
    d.primaryExperimentEvidence.experiments.map((e) => [
      e.experimentCode,
      e.evidence,
    ]),
  );
  const detailed = new Set(
    Object.values(bindings.cases)
      .filter((e) => e.scope === "detailed-comparison")
      .map((e) => e.code),
  );
  const evidence = packet.projects.map((summary) => {
    const match = bindings.projects[summary.id];
    if (!match) throw new Error("Missing canonical project binding");
    const rows = d.projects.filter(
      (p) =>
        p.projectAlias === match.projectAlias &&
        p.assigned === summary.assigned,
    );
    if (rows.length !== 1)
      throw new Error("Ambiguous canonical project binding");
    return projectEvidence(rows[0], summary, byCode, detailed);
  });
  if (process.argv[3] === "--check-projection-only") {
    console.log(
      JSON.stringify(
        evidence.map((e) => ({
          project: e.project,
          selected: e.scope.selectedExperiments,
          eligibleRoutes: e.scope.eligibleRouteCount,
          priorIssues: e.priorIssues.length,
        })),
      ),
    );
    return;
  }
  await immutable(join(dir, "project-source-packet.private.json"), {
    schemaVersion: 1,
    files,
    projects: evidence,
  });
  if (process.argv[3] === "--save-projection-only") return;
  const org = await getWeeklyReportOrganizationId();
  const result: Awaited<ReturnType<typeof reviewOne>>[] = new Array(
    evidence.length,
  );
  let next = 0;
  const failures: unknown[] = [];
  const worker = async () => {
    while (next < evidence.length && !failures.length) {
      const i = next++;
      try {
        result[i] = await reviewOne(dir, org, evidence[i]);
      } catch (e) {
        failures.push(e);
      }
    }
  };
  // Free slots take the next project immediately; finish in-flight work before
  // returning a failure so successful independently reviewed checkpoints survive.
  await Promise.all(
    Array.from({ length: Math.min(3, evidence.length) }, worker),
  );
  if (failures.length) throw failures[0];
  const rows = result.map((r) => r.row);
  const digest = await immutable(join(dir, "project-decisions.json"), {
    schemaVersion: 1,
    projects: rows,
  });
  await immutable(join(dir, "project-decisions-review.json"), {
    schemaVersion: 1,
    decisionBundleSha256: digest,
    files,
    projects: result.map((r) => {
      const local = d.projects.find(
        (s) => s.projectAlias === bindings.projects[r.row.project].projectAlias,
      );
      if (!local) throw new Error("Project ledger source not found");
      return {
        ...r.receipt,
        issueBindings: r.row.issueAssessments.map((v, i) => ({
          key: v.key,
          entryId: local.ledgerEntries[i].entryId,
        })),
      };
    }),
  });
  console.log(
    "Independent project judgments verified for " +
      rows.length +
      " projects and unassigned experiment groups.",
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main()
    .catch((e) => {
      console.error(
        e instanceof z.ZodError
          ? "Project evidence contract mismatch at " +
              e.issues
                .slice(0, 5)
                .map((i) => i.path.join(".") + ":" + i.code)
                .join(", ")
          : e instanceof Error
            ? e.message
            : "Project evidence contract mismatch",
      );
      process.exitCode = 1;
    })
    .finally(() => db.$disconnect());
}
