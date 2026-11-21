import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  finishVisualReview,
  verifyVisionBatch,
} from "../scripts/weekly-runner/vision-batches";

const digest = (c: string) => c.repeat(64);
const challenge = digest("a");
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
function receipt(n: number, blocked: boolean) {
  const images = [{ file: `qa/page-${n}.png`, sha256: digest("3") }];
  const canary = String(100000 + n);
  const batch = {
    challengeSha256: challenge,
    requestHash: digest(String(n)),
    responseHash: digest(String(n + 3)),
    responseId: `batch-${n}`,
    modelReturned: "deepseek-flash",
    canaryExpected: canary,
    canaryReceived: canary,
    images: [
      {
        ...images[0],
        index: 1,
        decision: blocked ? "BLOCK" : "PASS",
        observation: "The synthetic axes and the legend are readable.",
        defects: blocked ? ["Axis labels overlap in the upper plot."] : [],
        advisories: [],
      },
    ],
  };
  return { images, batch };
}

it("collects all views including later blockers, preserves the first judgment across resume and never signs a blocked report", async () => {
  const folder = await mkdtemp(join(tmpdir(), "weekly-vision-"));
  dirs.push(folder);
  async function review() {
    const seen = new Set<string>();
    const checks = [receipt(1, true), receipt(2, false), receipt(3, true)].map(
      ({ images, batch }) => verifyVisionBatch(batch, challenge, images, seen),
    );
    expect(checks.map((c) => c.verdict)).toEqual([
      "blocked",
      "clear",
      "blocked",
    ]);
    await finishVisualReview(
      folder,
      challenge,
      challenge,
      digest("b"),
      checks.map((c) => c.saved),
    );
  }
  await expect(review()).rejects.toThrow("2 image(s)");
  const original = await readFile(join(folder, "visual-findings.json"), "utf8");
  expect(JSON.parse(original)).toMatchObject({
    decision: "BLOCK",
    inspectedImages: 3,
    blocked: [{ file: "qa/page-1.png" }, { file: "qa/page-3.png" }],
  });
  await expect(review()).rejects.toThrow("2 image(s)");
  expect(await readFile(join(folder, "visual-findings.json"), "utf8")).toBe(
    original,
  );
  await expect(
    access(join(folder, "visual-review.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("stops immediately on an invalid canary, missing defect, wrong page, malformed recorded result or repeated receipt", () => {
  const { images, batch } = receipt(1, true);
  for (const value of [
    { ...batch, canaryReceived: "000011" },
    { ...batch, canaryReceived: "11", canaryExpected: "11" },
    { ...batch, responseHash: "bad" },
    { ...batch, modelReturned: "another-model" },
    ...[
      { index: 2 },
      { sha256: digest("c") },
      { defects: [] },
      { defects: [" "] },
      { observation: "x" },
    ].map((x) => ({ ...batch, images: [{ ...batch.images[0], ...x }] })),
  ]) {
    expect(() =>
      verifyVisionBatch(value, challenge, images, new Set()),
    ).toThrow();
  }
  const seen = new Set<string>();
  verifyVisionBatch(batch, challenge, images, seen);
  expect(() => verifyVisionBatch(batch, challenge, images, seen)).toThrow(
    "Reused",
  );
});

it("keeps contradictory PASS separate from a genuine BLOCK; signs an entirely clean report", async () => {
  const folder = await mkdtemp(join(tmpdir(), "weekly-vision-"));
  dirs.push(folder);
  const { batch, images } = receipt(1, false);
  const ambiguous = {
    ...batch,
    images: [{ ...batch.images[0], defects: ["A clipped axis."] }],
  };
  expect(
    verifyVisionBatch(ambiguous, challenge, images, new Set()).verdict,
  ).toBe("clarify");
  const clear = verifyVisionBatch(batch, challenge, images, new Set());
  await finishVisualReview(folder, challenge, challenge, digest("c"), [
    clear.saved,
  ]);
  expect(
    JSON.parse(await readFile(join(folder, "visual-review.json"), "utf8"))
      .batches,
  ).toHaveLength(1);
});
