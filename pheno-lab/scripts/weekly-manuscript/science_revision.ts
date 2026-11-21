import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  getWeeklyReportOrganizationId,
  callWeeklySciencePatch,
  callWeeklyScienceModel,
  hashWeeklyReportValue as hash,
} from "../weekly-report-model";
import { checkpoint, immutableWrite } from "./checkpoint";
import {
  scientificEditOutput,
  scientificEditSystem,
} from "./science-edits-contract";
import {
  privateScienceInputSchema,
  scienceInterpretationSchema,
  scienceReviewSchema,
  scienceReviewerSystem,
} from "./science-contract";
import { replayScienceEdit } from "./replay-science-edit.mjs";
import { bindScience } from "./science";

export async function correctScientificPassages(
  dir: string,
  baseAttempt: number,
) {
  if (!Number.isInteger(baseAttempt) || baseAttempt < 1 || baseAttempt > 5)
    throw Error("Invalid scientific review attempt");
  const load = async (file: string) =>
    JSON.parse(await readFile(join(dir, file), "utf8"));
  const sourceSelection = await load("science-source-selection.json");
  const publicDraft =
    sourceSelection.publicDraftHash === null
      ? null
      : await load("manuscript-candidate.json");
  if (
    publicDraft !== null &&
    hash(publicDraft) !== sourceSelection.publicDraftHash
  )
    throw Error("Frozen public draft changed");
  const evidence = privateScienceInputSchema.shape.evidence.parse({
    ...(await load("private-scientific-facts.json")),
    publicEvidence: await load("provider-packet.json"),
    publicDraft,
  });
  const base = await load(`scientist-attempt-${baseAttempt}.json`),
    prior = await load(`scientific-peer-attempt-${baseAttempt}.json`);
  let candidate = scienceInterpretationSchema.parse(base.value),
    critique = scienceReviewSchema.parse(prior.value);
  const evidenceHash = hash(evidence);
  if (
    sourceSelection.evidenceHash !== evidenceHash ||
    base.evidenceHash !== evidenceHash ||
    prior.evidenceHash !== evidenceHash ||
    base.role !== "scientist" ||
    prior.role !== "chemist-reviewer" ||
    base.providerHost !== "api.deepseek.com" ||
    prior.providerHost !== "api.deepseek.com" ||
    base.model !== "deepseek-v4-pro" ||
    prior.model !== base.model ||
    !base.completionId ||
    !prior.completionId ||
    prior.completionId === base.completionId ||
    prior.authorCompletionId !== base.completionId ||
    prior.bindingFailure !== null ||
    prior.value.decision !== "REVISE" ||
    !prior.value.findings.length ||
    base.outputHash !== hash(candidate) ||
    prior.reviewedInterpretationHash !== base.outputHash ||
    prior.inputHash !== hash({ evidence, interpretation: candidate }) ||
    prior.outputHash !== hash(critique)
  )
    throw Error(
      "A scientific wording correction needs an authentic scope-bound requested revision",
    );
  bindScience(evidence, candidate);
  await immutableWrite(join(dir, "scientific-edit-anchor.json"), {
    baseAttempt,
    evidenceHash,
    baseOutputHash: base.outputHash,
    priorReviewHash: prior.outputHash,
  });
  const orgId = await getWeeklyReportOrganizationId();
  const completionIds = new Set([base.completionId, prior.completionId]);
  for (let i = 1; i <= 2; i++) {
    const name = `science-edit-${baseAttempt}-${i}`;
    const request = {
      evidence,
      revision: { previous: candidate, review: critique },
    };
    const editor = await checkpoint(
      join(dir, name + "-provider.json"),
      "scientific-reviser",
      scientificEditSystem,
      request,
      scientificEditOutput,
      () => callWeeklySciencePatch({ orgId, payload: request }),
    );
    if (completionIds.has(editor.completionId))
      throw Error("Scientific correction reused a model completion");
    completionIds.add(editor.completionId);
    candidate = scienceInterpretationSchema.parse(
      replayScienceEdit(candidate, editor.value),
    );
    bindScience(evidence, candidate);
    const peerInput = { evidence, interpretation: candidate },
      peerFile = join(dir, name + "-peer.json");
    const peer = await checkpoint(
      peerFile,
      "chemist-reviewer",
      scienceReviewerSystem,
      peerInput,
      scienceReviewSchema,
      () =>
        callWeeklyScienceModel({
          orgId,
          payload: peerInput,
          role: "chemist-reviewer",
        }),
    );
    if (completionIds.has(peer.completionId))
      throw Error("Scientific correction reused the author as reviewer");
    completionIds.add(peer.completionId);
    critique = peer.value;
    if (
      critique.decision === "PASS" &&
      !critique.findings.some((f) => f.severity === "blocking") &&
      critique.scientificAudit.length === evidence.cases.length &&
      evidence.cases.every(
        (c) =>
          critique.scientificAudit.filter(
            (x) =>
              x.experiment === c.experiment &&
              x.sourceHash === c.sourceHash &&
              x.verdict === "PASS",
          ).length === 1,
      )
    ) {
      const attested = {
        ...peer,
        reviewedInterpretationHash: hash(candidate),
        authorCompletionId: editor.completionId,
        publicDraftAtScienceSha256: sourceSelection.publicDraftHash,
        bindingFailure: null,
        reviewedAt: (await stat(peerFile)).mtime.toISOString(),
        targetedScienceBaseAttempt: baseAttempt,
        targetedScienceEdits: i,
      };
      await immutableWrite(join(dir, "science-interpretation.json"), candidate);
      await immutableWrite(
        join(dir, "independent-material-science-review.json"),
        attested,
      );
      console.log(
        "Corrected scientific manuscript approved after fresh full independent review.",
      );
      return;
    }
    if (critique.decision !== "REVISE" || !critique.findings.length) break;
  }
  throw Error(
    "Scientific wording corrections did not pass the independent review; draft and findings retained",
  );
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  if (process.argv.length !== 4)
    throw Error(
      "Usage: science_revision.ts run-directory reviewed-attempt-number",
    );
  correctScientificPassages(
    resolve(process.argv[2]),
    Number(process.argv[3]),
  ).catch((e) => {
    console.error(
      e instanceof Error ? e.message : "Scientific correction failed",
    );
    process.exitCode = 1;
  });
}
