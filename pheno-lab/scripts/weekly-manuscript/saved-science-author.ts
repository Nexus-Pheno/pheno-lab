import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  hashWeeklyReportValue as hash,
  callWeeklyScienceModel,
} from "../weekly-report-model";
import {
  scienceInterpretationSchema,
  privateScienceInputSchema,
} from "./science-contract";

export async function resumeScientificAuthor(
  dir: string,
  a: number,
  evidence: z.infer<typeof privateScienceInputSchema>["evidence"],
) {
  const load = async (f: string) =>
    JSON.parse(await readFile(join(dir, f), "utf8"));
  const files = await readdir(dir);
  const author = await load(`scientist-attempt-${a}.json`);
  const completions = files.filter(
    (n) =>
      n === `scientist-checkpoint-${a}.json` ||
      n === `scientist-checkpoint-${a}-corrected.json`,
  );
  let exact = false;
  for (const receipt of completions) {
    const { checkpointPolicy, ...contents } = await load(receipt);
    if (
      typeof checkpointPolicy === "string" &&
      isDeepStrictEqual(contents, author)
    )
      exact = true;
  }
  if (
    !exact ||
    author.role !== "scientist" ||
    author.provider !== "deepseek" ||
    author.providerHost !== "api.deepseek.com" ||
    author.model !== "deepseek-v4-pro" ||
    !author.requestId ||
    !author.completionId ||
    author.evidenceHash !== hash(evidence) ||
    author.outputHash !== hash(scienceInterpretationSchema.parse(author.value))
  )
    throw Error(
      "Saved scientific author does not match the exact official completion and frozen evidence",
    );
  const anchor = `scientific-author-pending-review-${a}.json`;
  if (files.includes(anchor)) {
    const pending = await load(anchor);
    if (
      pending.sourceHash !== author.evidenceHash ||
      pending.inputHash !== author.inputHash ||
      pending.outputHash !== author.outputHash ||
      pending.completionId !== author.completionId
    )
      throw Error("Pending independent scientific review changed");
  } else {
    let originalInput: unknown = { evidence };
    if (a > 1) {
      const prior = await load(`scientist-attempt-${a - 1}.json`),
        peer = await load(`scientific-peer-attempt-${a - 1}.json`);
      if (
        peer.value.decision !== "REVISE" ||
        peer.bindingFailure !== null ||
        peer.evidenceHash !== hash(evidence) ||
        peer.reviewedInterpretationHash !== hash(prior.value) ||
        peer.inputHash !== hash({ evidence, interpretation: prior.value }) ||
        peer.authorCompletionId !== prior.completionId ||
        peer.completionId === prior.completionId
      )
        throw Error(
          "Cannot reconstruct the interrupted scientific author's prior critique",
        );
      originalInput = {
        evidence,
        revision: { previous: prior.value, review: peer.value },
      };
    }
    if (author.inputHash !== hash(originalInput))
      throw Error("Cannot verify the interrupted scientific author's input");
  }
  if (
    files.includes(`scientific-peer-attempt-${a}.json`) ||
    files.some((n) => n.startsWith(`nonpublishable-chemist-reviewer-${a}-`))
  )
    throw Error(
      "The saved scientist already has a completed or malformed scientific review requiring reconciliation",
    );
  if (!files.includes(`chemist-review-checkpoint-${a}.json`))
    await writeFile(
      join(dir, `scientific-peer-retry-${a}.claim`),
      JSON.stringify({
        source: author.evidenceHash,
        draft: author.outputHash,
      }) + "\n",
      { flag: "wx", mode: 0o600 },
    );
  type Saved = Awaited<ReturnType<typeof callWeeklyScienceModel>> & {
    value: z.infer<typeof scienceInterpretationSchema>;
  };
  return author as Omit<Saved, "value"> & {
    value: z.infer<typeof scienceInterpretationSchema>;
  };
}
