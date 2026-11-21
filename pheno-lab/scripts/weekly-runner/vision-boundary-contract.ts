import { z } from "zod";
import { verifyVisionBatch } from "./vision-batches";

export const hash = z.string().regex(/^[a-f0-9]{64}$/);
const digits = z.string().regex(/^\d{6}$/);
const mobile = /^qa\/(en|zh)-(320|390)-viewport\.png$/;
const image = z.object({ file: z.string(), sha256: hash }).strict();
export const challengeSchema = z.object({
  schemaVersion: z.literal(1),
  challenge: hash,
  contentSha256: hash,
  images: z.array(image).min(1).max(600),
});
const evidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    challengeSha256: hash,
    contentSha256: hash,
    original: image,
    continuation: image,
    horizontalViews: z.array(image).max(6).optional().default([]),
    geometry: z.record(z.string(), z.unknown()),
  })
  .strict();
const observation = z.string().trim().min(20).max(1500);
export const judgmentSchema = z
  .object({
    canary: digits,
    classification: z.enum([
      "NORMAL_VIEWPORT_CONTINUATION",
      "PERSISTENT_DEFECT",
      "INDETERMINATE",
    ]),
    originalObservation: observation,
    continuationObservation: observation,
    continuity: observation,
    assessment: observation,
    defects: z.array(z.string().trim().min(5).max(450)).max(8),
  })
  .strict();
export const answerSchema = z.object({
  id: z.string().min(5),
  model: z.string().regex(/^deepseek-(flash|v4\.1-flash(?:-[0-9]+)?)$/i),
  choices: z.tuple([
    z.object({
      finish_reason: z.literal("stop"),
      message: z.object({ content: z.string() }),
    }),
  ]),
});

export function stem(file: string) {
  if (!mobile.test(file))
    throw Error("A normal mobile scrolling viewport is required.");
  return file.slice(3, -4);
}

export function originalBlock(
  raw: unknown,
  challenge: z.infer<typeof challengeSchema>,
  challengeDigest: string,
  file: string,
  seen: Set<string>,
) {
  stem(file);
  const matches = challenge.images.flatMap((p, i) =>
    p.file === file ? [i] : [],
  );
  if (matches.length !== 1)
    throw Error(
      "Original viewport must occur exactly once in the official manifest.",
    );
  const index = matches[0],
    start = index - (index % 3);
  const { saved, verdict } = verifyVisionBatch(
    raw,
    challengeDigest,
    challenge.images.slice(start, start + 3),
    seen,
  );
  const page = saved.images[index - start];
  if (
    verdict !== "blocked" ||
    page.decision !== "BLOCK" ||
    page.defects.length !== 1
  )
    throw Error(
      "Only a single original viewport boundary defect may be considered.",
    );
  // A separate concern, such as overlapping labels, remains blocking.
  const defect = page.defects[0];
  if (
    !/\b(viewport|screen|bottom(?: edge)?|scroll(?:ing)?)\b/i.test(defect) ||
    !/\b(table|row|header|column|heading|cell)\b/i.test(defect) ||
    !/\b(clip(?:ped|ping)?|cut\s*off|cut|truncat\w*|partially|half|outside|beyond)\b/i.test(
      defect,
    ) ||
    /\b(overlap\w*|corrupt\w*|missing glyph|black block|wrong|mislabel\w*)\b/i.test(
      defect,
    )
  )
    throw Error("Original defect is outside the scrolling-boundary review.");
  return { page, saved, start };
}

export function boundaryEvidence(
  raw: unknown,
  challenge: z.infer<typeof challengeSchema>,
  challengeDigest: string,
  file: string,
) {
  const name = stem(file),
    manifest = evidenceSchema.parse(raw);
  if (
    manifest.challengeSha256 !== challengeDigest ||
    manifest.contentSha256 !== challenge.contentSha256 ||
    manifest.original.file !== file ||
    manifest.original.sha256 !==
      challenge.images.find((p) => p.file === file)?.sha256 ||
    manifest.continuation.file !== "boundary-" + name + "-continuation.png" ||
    !Object.keys(manifest.geometry).length ||
    manifest.horizontalViews.some(
      (p, i) => p.file !== "boundary-" + name + "-pan-" + (i + 1) + ".png",
    )
  )
    throw Error(
      "Scroll evidence must match the frozen rendering and exact image sequence.",
    );
  const refs = [
    manifest.original,
    manifest.continuation,
    ...manifest.horizontalViews,
  ];
  if (new Set(refs.map((p) => p.sha256)).size !== refs.length)
    throw Error("Duplicate continuation evidence.");
  return manifest;
}

export function verifyJudgment(
  raw: unknown,
  token: string,
  seen: Set<string>,
  responseId: string,
) {
  const result = judgmentSchema.parse(raw);
  if (
    result.canary !== token ||
    seen.has(token) ||
    seen.has("id:" + responseId)
  )
    throw Error("Independent calibration or provider completion is invalid.");
  if (
    (result.classification === "NORMAL_VIEWPORT_CONTINUATION") !==
    (result.defects.length === 0)
  )
    throw Error("Boundary verdict contradicts the independent findings.");
  return result;
}
