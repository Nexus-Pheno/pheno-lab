import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const digits = z.string().regex(/^\d{6}$/);
const image = z.object({
  file: z.string().regex(/^qa\/[a-z0-9-]+\.png$/),
  sha256: digest,
});
const page = z.object({
  index: z.number().int().positive(),
  decision: z.enum(["PASS", "BLOCK"]),
  observation: z.string().trim().min(18).max(650),
  defects: z.array(z.string().trim().min(1)).max(12),
  advisories: z.array(z.string().trim().min(1)).max(12),
});
export const visionResult = z.object({ canary: digits, pages: z.array(page) });
const batch = z.object({
  challengeSha256: digest,
  requestHash: digest,
  responseHash: digest,
  responseId: z.string().trim().min(5),
  modelReturned: z
    .string()
    .regex(/^deepseek-(flash|v4\.1-flash(?:-[0-9]+)?)$/i),
  canaryExpected: digits,
  canaryReceived: digits,
  images: z.array(image.extend(page.shape)).min(1),
});

export type VisionBatch = z.infer<typeof batch>;
export function verifyVisionBatch(
  value: unknown,
  challengeHash: string,
  images: z.infer<typeof image>[],
  seen: Set<string>,
) {
  const saved = batch.parse(value);
  if (
    saved.challengeSha256 !== challengeHash ||
    saved.canaryExpected !== saved.canaryReceived ||
    saved.images.length !== images.length ||
    saved.images.some(
      (p, i) =>
        p.index !== i + 1 ||
        p.file !== images[i].file ||
        p.sha256 !== images[i].sha256 ||
        (p.decision === "BLOCK" && !p.defects.length),
    )
  ) {
    throw Error("Invalid vision evidence, page order, or calibration.");
  }
  for (const id of [
    saved.canaryExpected,
    "req:" + saved.requestHash,
    "res:" + saved.responseHash,
    "id:" + saved.responseId,
  ]) {
    if (seen.has(id))
      throw Error("Reused vision calibration or provider receipt.");
    seen.add(id);
  }
  const block = saved.images.some((p) => p.decision === "BLOCK");
  const ambiguous = saved.images.some(
    (p) => p.decision === "PASS" && p.defects.length,
  );
  if (block && ambiguous)
    throw Error(
      "Vision batch combines blocked pages with contradictory verdicts.",
    );
  return {
    saved,
    verdict: ambiguous ? "clarify" : block ? "blocked" : "clear",
  };
}

export async function finishVisualReview(
  reviewDir: string,
  challenge: string,
  challengeSha256: string,
  contentSha256: string,
  batches: VisionBatch[],
) {
  const blocked = batches.flatMap((b) =>
    b.images
      .filter((p) => p.decision === "BLOCK")
      .map((p) => ({
        ...p,
        requestHash: b.requestHash,
        responseHash: b.responseHash,
        responseId: b.responseId,
      })),
  );
  if (blocked.length) {
    const file = join(reviewDir, "visual-findings.json");
    const bytes = JSON.stringify({
      schemaVersion: 1,
      decision: "BLOCK",
      challenge,
      challengeSha256,
      contentSha256,
      inspectedImages: batches.reduce((n, b) => n + b.images.length, 0),
      blocked,
    });
    try {
      await writeFile(file, bytes, { mode: 0o600, flag: "wx" });
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "EEXIST" ||
        (await readFile(file, "utf8")) !== bytes
      )
        throw error;
    }
    throw Error(
      `Visual review blocked on ${blocked.length} image(s). See visual-findings.json.`,
    );
  }
  await writeFile(
    join(reviewDir, "visual-review.json"),
    JSON.stringify({
      schemaVersion: 1,
      role: "visual",
      challenge,
      challengeSha256,
      contentSha256,
      completedAt: new Date().toISOString(),
      model: "deepseek-flash",
      batches,
    }),
    { mode: 0o600, flag: "wx" },
  );
}
