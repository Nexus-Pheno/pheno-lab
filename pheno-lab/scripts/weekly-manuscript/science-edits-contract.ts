import { z } from "zod";
import { scientificInstructions } from "./science-contract";

const short = z.string().min(1).max(900);
export const scientificEditOutput = z.strictObject({
  changes: z
    .array(
      z.strictObject({
        path: z
          .string()
          .max(150)
          .regex(/^[a-zA-Z0-9]+(?:\.[a-zA-Z0-9]+){1,7}$/),
        replacement: z.union([short, z.strictObject({ en: short, zh: short })]),
      }),
    )
    .min(1)
    .max(90),
});

export const scientificEditSystem = [
  scientificInstructions,
  "You are the correcting scientific author. Revise the exact previous manuscript against the actual independent review and source evidence. Return ONLY {changes:[{path,replacement},...]}. Use zero-based array indexes in dot-separated paths into revision.previous, never source aliases as array indices. Replace existing bilingual passages as a whole with {en,zh}; for private chemical narrative strings use a plain string. You may edit cases.N.public text, its nested bilingual signatures/branches/conditions/design interpretation, cases.N.chemical narrative strings, priorities.N, followupAssessments.N.rationale, or literatureNotes.articles.N bilingual finding, studyLimit and uses.N.relevance or limit. Never change IDs, hashes, group assignments, material identity, citations, structured attainment status or any array length. Correct all affected statements in both languages and retain every already-correct passage. No change description or other field. If the reviewer questions an unmeasured condition or a planned control, preserve that uncertainty and express the quantitative observation separately. Fix causal attribution and all stated differences directly from supplied device results. Do not relax the criticism or introduce unrelated hypotheses.",
].join("\n");
