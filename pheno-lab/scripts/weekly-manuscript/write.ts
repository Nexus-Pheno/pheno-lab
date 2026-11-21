import { readFile, readdir } from "node:fs/promises";
import { checkpoint, immutableWrite } from "./checkpoint";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  authorSystem,
  measuredReference,
  manuscriptSchema,
  peerReviewSchema,
  projectionSchema,
  reviewerSystem,
} from "./contract";
import {
  callWeeklyReportModel,
  getWeeklyReportOrganizationId,
  hashWeeklyReportValue,
} from "../weekly-report-model";

export function checkBindings(
  evidence: z.output<typeof projectionSchema>,
  draft: z.output<typeof manuscriptSchema>,
) {
  const same = (wanted: string[], found: string[]) =>
    wanted.length === found.length &&
    new Set(found).size === found.length &&
    wanted.every((k, i) => k === found[i]);
  if (
    !same(
      evidence.projects.map((p) => p.id),
      draft.projects.map((p) => p.project),
    ) ||
    !same(
      evidence.cases.map((e) => e.id),
      draft.cases.map((e) => e.experiment),
    )
  )
    throw new Error("Manuscript source coverage or order differs");
  for (const [i, section] of draft.cases.entries()) {
    const source = evidence.cases[i];
    const test = source.characterizations.find(
      (c) => c.id === section.characterization,
    );
    const group = test?.groups.find((g) => g.id === section.comparator);
    const ref = test?.groups.find((g) => g.id === section.reference);
    if (
      !group?.stats.pce?.n ||
      section.reference !==
        measuredReference(test?.groups, source.selectedReference) ||
      (section.reference !== null &&
        (!ref?.stats.pce?.n || section.reference === section.comparator)) ||
      section.papers.some((id) => !evidence.papers.includes(id))
    )
      throw new Error(
        "Invalid comparison, characterization or literature binding",
      );
  }
}

async function main() {
  if (process.argv.length !== 3)
    throw new Error("Usage: write.ts <private run directory>");
  const dir = resolve(process.argv[2]);
  const evidence = projectionSchema.parse(
    JSON.parse(await readFile(join(dir, "provider-packet.json"), "utf8")),
  );
  const orgId = await getWeeklyReportOrganizationId();
  const evidenceHash = hashWeeklyReportValue(evidence);
  let revision: z.output<typeof peerReviewSchema> | undefined;
  let previousDraft: z.output<typeof manuscriptSchema> | undefined;
  const files = await readdir(dir);
  let after = 0;
  for (let i = 3; i >= 1; i--) {
    if (!files.includes(`peer-attempt-${i}.json`)) continue;
    const author = JSON.parse(
      await readFile(join(dir, `author-attempt-${i}.json`), "utf8"),
    );
    const peer = JSON.parse(
      await readFile(join(dir, `peer-attempt-${i}.json`), "utf8"),
    );
    const draft = manuscriptSchema.parse(author.value),
      verdict = peerReviewSchema.parse(peer.value);
    if (
      author.role !== "author" ||
      peer.role !== "reviewer" ||
      author.model !== "deepseek-v4-pro" ||
      peer.model !== author.model ||
      author.providerHost !== "api.deepseek.com" ||
      peer.providerHost !== author.providerHost ||
      !author.completionId ||
      !peer.completionId ||
      author.completionId === peer.completionId ||
      author.requestHash === peer.requestHash ||
      author.evidenceHash !== evidenceHash ||
      peer.evidenceHash !== evidenceHash ||
      author.outputHash !== hashWeeklyReportValue(draft) ||
      peer.reviewedManuscriptHash !== author.outputHash ||
      peer.outputHash !== hashWeeklyReportValue(verdict) ||
      peer.inputHash !== hashWeeklyReportValue({ evidence, draft })
    )
      throw Error(
        "Previous manuscript and critique do not bind to this evidence.",
      );
    if (
      verdict.decision === "PASS" &&
      verdict.findings.every((f) => f.severity !== "blocking")
    ) {
      checkBindings(evidence, draft);
      await immutableWrite(join(dir, "manuscript-candidate.json"), draft);
      await immutableWrite(join(dir, "public-model-review.json"), peer);
      return;
    }
    if (verdict.decision !== "REVISE" || !verdict.findings.length)
      throw Error(
        "The scientific review needs new evidence or a substantive correction.",
      );
    after = i;
    previousDraft = draft;
    revision = verdict;
    break;
  }
  for (let attempt = after + 1; attempt <= 3; attempt++) {
    const writerInput = {
      evidence,
      ...(revision ? { revision, previousDraft } : {}),
    };
    const author = await checkpoint(
      join(dir, `writer-checkpoint-${attempt}.json`),
      "author",
      authorSystem,
      writerInput,
      manuscriptSchema,
      () =>
        callWeeklyReportModel({
          orgId,
          role: "author",
          system: authorSystem,
          payload: writerInput,
          schema: manuscriptSchema,
        }),
    );
    if (
      author.evidenceHash !== evidenceHash ||
      author.outputHash !== hashWeeklyReportValue(author.value)
    )
      throw new Error("Writer evidence binding differs");
    await immutableWrite(join(dir, `author-attempt-${attempt}.json`), author);
    let bindingFailure: string | null = null;
    try {
      checkBindings(evidence, author.value);
    } catch (err) {
      bindingFailure =
        err instanceof Error ? err.message : "Missing source binding";
    }
    const peerInput = { evidence, draft: author.value };
    const reviewer = await checkpoint(
      join(dir, `public-peer-checkpoint-${attempt}.json`),
      "reviewer",
      reviewerSystem,
      peerInput,
      peerReviewSchema,
      () =>
        callWeeklyReportModel({
          orgId,
          role: "reviewer",
          system: reviewerSystem,
          payload: peerInput,
          schema: peerReviewSchema,
        }),
    );
    if (
      reviewer.evidenceHash !== evidenceHash ||
      reviewer.inputHash !==
        hashWeeklyReportValue({ evidence, draft: author.value }) ||
      reviewer.completionId === author.completionId ||
      reviewer.requestHash === author.requestHash
    )
      throw new Error("Independent review did not bind this manuscript");
    const attestation = {
      ...reviewer,
      reviewedManuscriptHash: author.outputHash,
    };
    await immutableWrite(
      join(dir, `peer-attempt-${attempt}.json`),
      attestation,
    );
    if (
      !bindingFailure &&
      reviewer.value.decision === "PASS" &&
      reviewer.value.findings.every((f) => f.severity !== "blocking")
    ) {
      await immutableWrite(
        join(dir, "manuscript-candidate.json"),
        author.value,
      );
      await immutableWrite(join(dir, "public-model-review.json"), attestation);
      console.log("Public candidate and bound independent model review saved.");
      return;
    }
    if (
      reviewer.value.decision === "BLOCK" ||
      (!bindingFailure && !reviewer.value.findings.length)
    )
      break;
    previousDraft = author.value;
    revision = { ...reviewer.value, findings: [...reviewer.value.findings] };
    if (bindingFailure && revision.findings.length < 20)
      revision.findings.push({
        severity: "blocking",
        location: "comparison evidence binding",
        issue: bindingFailure,
        correction:
          "Use the selected reference and nonempty measurement groups from the supplied characterization.",
      });
  }
  throw new Error(
    "Independent public manuscript review requires further work; saved all available drafts",
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : "Weekly manuscript failed");
    process.exitCode = 1;
  });
}
