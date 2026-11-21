import { readFile, stat, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { measuredReference } from "./contract";
import {
  getWeeklyReportOrganizationId,
  callWeeklyScienceModel,
  hashWeeklyReportValue,
} from "../weekly-report-model";
import {
  privateScienceInputSchema,
  previousScienceDraftSchema,
  scienceInterpretationSchema,
  scienceReviewSchema,
  scienceSystem,
  scienceReviewerSystem,
} from "./science-contract";
import { immutableWrite, checkpoint } from "./checkpoint";
import { resumeScientificAuthor } from "./saved-science-author";

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
  const chemicalErrors: string[] = [];
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
      measuredReference(groups, facts?.selectedReference) !== c.reference ||
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
      throw Error(
        c.experiment +
          " uses an experiment or unknown identifier in chemical.sources. Allowed primary-paper IDs: " +
          evidence.articles.map((p) => p.id).join(", "),
      );
    const recipes = new Set(source.recipes.map((r) => r.id));
    if (
      chem.recipes.length !== recipes.size ||
      new Set(chem.recipes.map((r) => r.id)).size !== recipes.size ||
      chem.recipes.some((r) => !recipes.has(r.id))
    )
      throw Error("Recipe-context coverage differs");
    const m = source.materials.find((x) => x.id === chem.material);
    const invalid: string[] = [];
    if (chem.status === "CURRENT_VERIFIED_GRAPH") {
      if (!m?.graph) {
        invalid.push("material must resolve to a supplied current graph");
      } else {
        if (m.name !== chem.displayName)
          invalid.push(
            "displayName must exactly equal the selected material.name",
          );
        if (!chem.graphHypotheses.length || !chem.compatibility.length)
          invalid.push("give case-bound graphHypotheses and compatibility");
        if (
          !chem.consultedDescriptorFields.length ||
          chem.consultedDescriptorFields.some(
            (k) => !(k in m.graph!.descriptor),
          )
        )
          invalid.push(
            "copy consultedDescriptorFields from material.graph.descriptor keys",
          );
        if (chem.consultedMotifFields.some((k) => !(k in m.graph!.motifs)))
          invalid.push(
            "copy consultedMotifFields from material.graph.motifs keys",
          );
      }
    } else {
      if (chem.material !== null && (!m || m.name !== chem.displayName))
        invalid.push(
          "displayName must exactly match material, or material must be null when unresolved",
        );
      for (const field of [
        "graphHypotheses",
        "compatibility",
        "consultedDescriptorFields",
        "consultedMotifFields",
      ] as const)
        if (chem[field].length)
          invalid.push(field + " must be empty for unresolved identity");
    }
    if (invalid.length)
      chemicalErrors.push(c.experiment + ": " + invalid.join(", "));
  }
  if (chemicalErrors.length)
    throw Error(chemicalErrors.join(" | ").slice(0, 900));
}

async function main() {
  const after =
    process.argv[3] === "--continue-after-review" ? Number(process.argv[4]) : 0;
  let resume =
    process.argv[3] === "--review-saved" ? Number(process.argv[4]) : 0;
  if (
    process.argv.length !== 3 &&
    !(
      process.argv.length === 5 &&
      ((Number.isInteger(after) && after > 0 && after <= 3) ||
        (Number.isInteger(resume) && resume > 0 && resume <= 5))
    )
  )
    throw Error(
      "Usage: science.ts private-run-directory [--continue-after-review attempt | --review-saved attempt]",
    );
  const dir = resolve(process.argv[2]);
  if (!after && !resume) {
    const files = await readdir(dir);
    const pending = [1, 2, 3].filter(
      (n) =>
        files.includes(`scientist-attempt-${n}.json`) &&
        !files.includes(`scientific-peer-attempt-${n}.json`),
    );
    if (pending.length > 1)
      throw Error(
        "More than one interrupted scientific reviewer requires reconciliation",
      );
    resume = pending[0] ?? 0;
  }
  const load = async (file: string) =>
    JSON.parse(await readFile(join(dir, file), "utf8"));
  let publicDraft;
  try {
    publicDraft = await load("manuscript-candidate.json");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    publicDraft = null;
  }
  const facts = {
    ...(await load("private-scientific-facts.json")),
    publicEvidence: await load("provider-packet.json"),
  };
  const selection = "science-source-selection.json";
  let existingHash: string | null | undefined;
  try {
    existingHash = (await load(selection)).evidenceHash;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // For interrupted older runs, the saved official response also binds whether
  // its author received the provisional public draft.
  if (existingHash === undefined) {
    const prior = (await readdir(dir)).find(
      (f) =>
        f.startsWith("nonpublishable-scientist-") ||
        f === "scientist-attempt-1.json",
    );
    if (prior) existingHash = (await load(prior)).evidenceHash;
  }
  const parse = (draft: unknown) =>
    privateScienceInputSchema.shape.evidence.parse({
      ...facts,
      publicDraft: draft,
    });
  let evidence = parse(publicDraft);
  if (
    existingHash !== undefined &&
    existingHash !== hashWeeklyReportValue(evidence)
  ) {
    evidence = parse(null);
    if (existingHash !== hashWeeklyReportValue(evidence))
      throw Error("Frozen scientist source changed; preserve the existing run");
    publicDraft = null;
  }
  await immutableWrite(join(dir, selection), {
    evidenceHash: hashWeeklyReportValue(evidence),
    publicDraftHash:
      publicDraft === null ? null : hashWeeklyReportValue(publicDraft),
  });
  const preserveRejected =
    (role: string, attempt: number) =>
    async (draft: unknown, paths: string[], completionId: string) => {
      const safeId = hashWeeklyReportValue(completionId);
      await immutableWrite(
        join(dir, `nonpublishable-${role}-${attempt}-${safeId}.json`),
        {
          classification: "PRIVATE_REJECTED_MODEL_DRAFT_DO_NOT_PUBLISH",
          completionId,
          role,
          evidenceHash: hashWeeklyReportValue(evidence),
          paths,
          draft,
        },
      );
    };
  const orgId = await getWeeklyReportOrganizationId();
  let revision: z.output<typeof privateScienceInputSchema>["revision"];
  if (after) {
    // Continue a genuine negative review under an improved contract, keeping
    // the original response and every finding. An accepted or source-mismatched
    // manuscript is never silently regenerated.
    const original = await load(`scientist-attempt-${after}.json`);
    const peer = await load(`scientific-peer-attempt-${after}.json`);
    const source = hashWeeklyReportValue(evidence);
    if (
      original.evidenceHash !== source ||
      peer.evidenceHash !== source ||
      peer.role !== "chemist-reviewer" ||
      original.role !== "scientist" ||
      peer.authorCompletionId !== original.completionId ||
      peer.completionId === original.completionId ||
      peer.reviewedInterpretationHash !==
        hashWeeklyReportValue(original.value) ||
      peer.reviewedInterpretationHash !== original.outputHash ||
      peer.inputHash !==
        hashWeeklyReportValue({ evidence, interpretation: original.value }) ||
      peer.outputHash !== hashWeeklyReportValue(peer.value) ||
      peer.value.decision === "BLOCK" ||
      (peer.value.decision === "PASS" && !peer.bindingFailure)
    )
      throw Error(
        "Previous private revision is not eligible for renewed authoring",
      );
    const review = scienceReviewSchema.parse(peer.value);
    if (peer.bindingFailure && review.findings.length < 25)
      review.findings.push({
        location: "chemical.sources and source binding",
        severity: "blocking",
        issue: peer.bindingFailure,
        correction:
          "Cite the supplied published work by its literature ID (e.g., LINKER, BURIED_CONTACT, LIGAND, S1 or S2), never by E experiment number. Name the limited relevance of the actual paper you selected. For IDENTITY_UNRESOLVED use empty compatibility/graph arrays and put any recipe mismatch under limitations. For a verified graph copy the exact registered name and descriptor/motif key spelling from the selected material, never a paraphrase.",
      });
    revision = {
      previous: previousScienceDraftSchema.parse(original.value),
      review,
    };
    await immutableWrite(join(dir, `continuation-from-review-${after}.json`), {
      priorRequest: original.requestHash,
      priorReview: peer.requestHash,
      evidenceHash: source,
      reviewedInterpretationHash: peer.reviewedInterpretationHash,
    });
  }
  const limit = after ? after + 2 : Math.max(3, resume);
  for (let a = resume || after + 1; a <= limit; a++) {
    const basicInput = { evidence, ...(revision ? { revision } : {}) };
    const prefix = `nonpublishable-scientist-${a}-`;
    const rejected = async () => {
      const files = (await readdir(dir))
        .filter((n) => n.startsWith(prefix) && n.endsWith(".json"))
        .sort();
      if (!files.length) return undefined;
      if (files.length > 1)
        throw Error(
          "Scientific response still fails the corrected contract; retained both drafts",
        );
      const prior = await load(files[0]);
      if (
        prior.role !== "scientist" ||
        prior.evidenceHash !== hashWeeklyReportValue(evidence) ||
        prior.classification !==
          "PRIVATE_REJECTED_MODEL_DRAFT_DO_NOT_PUBLISH" ||
        files[0] !==
          prefix + hashWeeklyReportValue(prior.completionId) + ".json"
      )
        throw Error("Rejected scientific draft is not bound to this period");
      const old = z
        .object({
          cases: z.array(z.unknown()).optional(),
          priorities: z.array(z.unknown()).optional(),
        })
        .safeParse(prior.draft);
      const validEarlierCases = (
        old.success ? (old.data.cases ?? []) : []
      ).flatMap((c) => {
        const result =
          scienceInterpretationSchema.shape.cases.element.safeParse(c);
        return result.success &&
          evidence.cases.some(
            (e) =>
              e.experiment === result.data.experiment &&
              e.sourceHash === result.data.sourceHash,
          )
          ? [result.data]
          : [];
      });
      const validPriorities = (
        old.success ? (old.data.priorities ?? []) : []
      ).flatMap((c) => {
        const result =
          scienceInterpretationSchema.shape.priorities.element.safeParse(c);
        return result.success ? [result.data] : [];
      });
      return privateScienceInputSchema.shape.formatRepair.unwrap().parse({
        rejectedCompletionHash: hashWeeklyReportValue(prior.completionId),
        paths: prior.paths,
        validEarlierCases,
        validPriorities,
      });
    };
    const getAuthor = async (
      formatRepair: Awaited<ReturnType<typeof rejected>>,
    ) => {
      const writerInput = {
        ...basicInput,
        ...(formatRepair ? { formatRepair } : {}),
      };
      return checkpoint(
        join(
          dir,
          `scientist-checkpoint-${a}${formatRepair ? "-corrected" : ""}.json`,
        ),
        "scientist",
        scienceSystem,
        writerInput,
        scienceInterpretationSchema,
        () =>
          callWeeklyScienceModel({
            orgId,
            role: "scientist",
            onInvalidOutput: preserveRejected("scientist", a),
            payload: writerInput,
          }),
      );
    };
    let formatRepair = await rejected();
    let author;
    if (resume === a) {
      author = await resumeScientificAuthor(dir, a, evidence);
    } else
      try {
        author = await getAuthor(formatRepair);
      } catch (error) {
        if (formatRepair) throw error;
        formatRepair = await rejected();
        if (!formatRepair) throw error;
        author = await getAuthor(formatRepair);
      }
    await immutableWrite(join(dir, `scientist-attempt-${a}.json`), author);
    await immutableWrite(
      join(dir, `scientific-author-pending-review-${a}.json`),
      {
        sourceHash: author.evidenceHash,
        inputHash: author.inputHash,
        outputHash: author.outputHash,
        completionId: author.completionId,
      },
    );
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
    const peer = await checkpoint(
      join(dir, `chemist-review-checkpoint-${a}.json`),
      "chemist-reviewer",
      scienceReviewerSystem,
      payload,
      scienceReviewSchema,
      () =>
        callWeeklyScienceModel({
          orgId,
          role: "chemist-reviewer",
          onInvalidOutput: preserveRejected("chemist-reviewer", a),
          payload,
        }),
    );
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
      reviewedAt: (
        await stat(join(dir, `chemist-review-checkpoint-${a}.json`))
      ).mtime.toISOString(),
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
    if (
      a === limit &&
      !bindingFailure &&
      peer.value.decision === "REVISE" &&
      peer.value.findings.length
    ) {
      const { correctScientificPassages } = await import("./science_revision");
      await correctScientificPassages(dir, a);
      return;
    }
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
