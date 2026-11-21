import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  getWeeklyReportOrganizationId,
  callWeeklyScienceModel,
  hashWeeklyReportValue,
} from "../weekly-report-model";
import {
  privateScienceInputSchema,
  scienceInterpretationSchema,
  scienceReviewSchema,
} from "./science-contract";
import { immutableWrite } from "./write";

type Evidence = z.output<typeof privateScienceInputSchema>["evidence"];
type Science = z.output<typeof scienceInterpretationSchema>;
export function bindScience(evidence: Evidence, science: Science) {
  const reviewed = new Set(science.followupAssessments.map((h) => h.id));
  if (
    reviewed.size !== evidence.followupRecords.length ||
    science.followupAssessments.length !== reviewed.size ||
    evidence.followupRecords.some(
      (h) =>
        !science.followupAssessments.some(
          (x) => x.id === h.id && x.experiment === h.experiment,
        ),
    )
  )
    throw Error("Prior-action review coverage differs");
  const ids = evidence.cases.map((e) => e.experiment);
  if (
    JSON.stringify(ids) !==
    JSON.stringify(science.cases.map((c) => c.experiment))
  )
    throw Error("Scientific case coverage or order differs");
  for (const [i, c] of science.cases.entries()) {
    const source = evidence.cases[i];
    const facts = evidence.publicEvidence.cases.find(
      (e) => e.id === c.experiment,
    );
    const groups = facts?.characterizations.find(
      (t) => t.id === c.characterization,
    )?.groups;
    if (
      source.sourceHash !== c.sourceHash ||
      facts?.selectedReference !== c.reference ||
      c.reference === c.comparator ||
      !groups?.find((g) => g.id === c.comparator)?.stats.pce?.n ||
      (c.reference !== null &&
        !groups.find((g) => g.id === c.reference)?.stats.pce?.n)
    )
      throw Error("Scientific primary result selection differs");
    const mentioned = new Set(c.public.conditions.map((g) => g.group));
    if (
      !mentioned.has(c.comparator) ||
      (c.reference !== null && !mentioned.has(c.reference)) ||
      [...mentioned].some((x) => !groups.some((g) => g.id === x))
    )
      throw Error("Scientific condition rows don't match compared arms");
    const chem = c.chemical;
    if (chem.sources.some((k) => !evidence.articles.some((p) => p.id === k)))
      throw Error("Public literature reference not supplied");
    const recipes = new Set(source.recipes.map((r) => r.id));
    if (
      chem.recipes.length !== recipes.size ||
      new Set(chem.recipes.map((r) => r.id)).size !== recipes.size ||
      chem.recipes.some((r) => !recipes.has(r.id))
    )
      throw Error("Recipe-context coverage differs");
    const m = source.materials.find((x) => x.id === chem.material);
    if (chem.status === "CURRENT_VERIFIED_GRAPH") {
      if (
        !m?.graph ||
        m.name !== chem.displayName ||
        !chem.graphHypotheses.length ||
        !chem.compatibility.length ||
        !chem.consultedDescriptorFields.length ||
        chem.consultedDescriptorFields.some(
          (d) => !(d in m.graph!.descriptor),
        ) ||
        chem.consultedMotifFields.some((d) => !(d in m.graph!.motifs))
      )
        throw Error("Graph, identity or consulted evidence does not match");
    } else if (
      (chem.material !== null && (!m || m.name !== chem.displayName)) ||
      chem.graphHypotheses.length ||
      chem.compatibility.length ||
      chem.consultedDescriptorFields.length ||
      chem.consultedMotifFields.length
    )
      throw Error(
        "Unresolved chemical identity contains graph-specific claims",
      );
  }
}

async function main() {
  if (process.argv.length !== 3)
    throw Error("Usage: science.ts private-run-directory");
  const dir = resolve(process.argv[2]);
  const load = async (file: string) =>
    JSON.parse(await readFile(join(dir, file), "utf8"));
  let publicDraft;
  try {
    publicDraft = await load("manuscript-candidate.json");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    publicDraft = null;
  }
  const evidence = privateScienceInputSchema.shape.evidence.parse({
    ...(await load("private-scientific-facts.json")),
    publicEvidence: await load("provider-packet.json"),
    publicDraft,
  });
  const orgId = await getWeeklyReportOrganizationId();
  let revision:
    | { previous: Science; review: z.output<typeof scienceReviewSchema> }
    | undefined;
  for (let a = 1; a <= 3; a++) {
    const author = await callWeeklyScienceModel({
      orgId,
      role: "scientist",
      payload: { evidence, ...(revision ? { revision } : {}) },
    });
    await immutableWrite(join(dir, `scientist-attempt-${a}.json`), author);
    // Even a binding error is presented to the independent reviewer. A positive
    // assessment cannot override the local deterministic evidence check.
    let bindingFailure: string | null = null;
    try {
      bindScience(evidence, author.value);
    } catch (e) {
      bindingFailure =
        e instanceof Error ? e.message : "Invalid source binding";
    }
    const payload = { evidence, interpretation: author.value };
    const peer = await callWeeklyScienceModel({
      orgId,
      role: "chemist-reviewer",
      payload,
    });
    if (
      peer.completionId === author.completionId ||
      peer.inputHash !== hashWeeklyReportValue(payload) ||
      peer.evidenceHash !== author.evidenceHash ||
      peer.evidenceHash !== hashWeeklyReportValue(evidence) ||
      author.outputHash !== hashWeeklyReportValue(author.value)
    )
      throw Error("Independent private review source/manuscript mismatch");
    const attested = {
      ...peer,
      reviewedInterpretationHash: author.outputHash,
      authorCompletionId: author.completionId,
      publicDraftAtScienceSha256:
        publicDraft === null ? null : hashWeeklyReportValue(publicDraft),
      bindingFailure,
      reviewedAt: new Date().toISOString(),
    };
    await immutableWrite(
      join(dir, `scientific-peer-attempt-${a}.json`),
      attested,
    );
    const all = evidence.cases.every(
      (e) =>
        peer.value.scientificAudit.filter(
          (r) =>
            r.experiment === e.experiment &&
            r.sourceHash === e.sourceHash &&
            r.verdict === "PASS",
        ).length === 1,
    );
    if (
      !bindingFailure &&
      peer.value.decision === "PASS" &&
      peer.value.scientificAudit.length === evidence.cases.length &&
      all &&
      !peer.value.findings.some((f) => f.severity === "blocking")
    ) {
      await immutableWrite(
        join(dir, "science-interpretation.json"),
        author.value,
      );
      await immutableWrite(
        join(dir, "independent-material-science-review.json"),
        attested,
      );
      console.log(
        "Independent scientific/chemistry interpretation approved for local manuscript assembly.",
      );
      return;
    }
    if (peer.value.decision === "BLOCK") break;
    const review = { ...peer.value, findings: [...peer.value.findings] };
    if (bindingFailure && review.findings.length < 25)
      review.findings.push({
        location: "case evidence binding",
        issue: bindingFailure,
        correction:
          "Repair the source linkage and retain unresolved quantities.",
        severity: "blocking",
      });
    revision = { previous: author.value, review };
  }
  throw Error(
    "Private scientific review incomplete; preserved author and independent review artifacts",
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : "Private science failed");
    process.exitCode = 1;
  });
