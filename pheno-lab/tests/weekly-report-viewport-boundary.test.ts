import { describe, expect, it } from "vitest";
import {
  boundaryEvidence,
  originalBlock,
  verifyJudgment,
} from "../scripts/weekly-runner/vision-boundary-contract";

const hash = (n: number) => String(n).repeat(64);
const file = "qa/zh-390-viewport.png";
const challenge = {
  schemaVersion: 1 as const,
  challenge: hash(1),
  contentSha256: hash(2),
  images: [{ file, sha256: hash(3) }],
};
const batch = {
  challengeSha256: hash(4),
  requestHash: hash(5),
  responseHash: hash(6),
  responseId: "one-request",
  modelReturned: "deepseek-flash",
  canaryExpected: "100001",
  canaryReceived: "100001",
  images: [
    {
      ...challenge.images[0],
      index: 1,
      decision: "BLOCK",
      observation:
        "Only the top half of the project table appears in this first view.",
      defects: ["Bottom table is cut off mid-header by the viewport."],
      advisories: [],
    },
  ],
};
const evidence = {
  schemaVersion: 1,
  challengeSha256: hash(4),
  contentSha256: hash(2),
  original: challenge.images[0],
  continuation: {
    file: "boundary-zh-390-viewport-continuation.png",
    sha256: hash(7),
  },
  horizontalViews: [
    { file: "boundary-zh-390-viewport-pan-1.png", sha256: hash(8) },
  ],
  geometry: { viewport: { width: 390, height: 844 } },
};
const observations = {
  originalObservation:
    "The top viewport shows only half of the vertically wrapped word.",
  continuationObservation:
    "The continuation shows the full word and first rows.",
  continuity: "Grid lines, the title and header align between the two views.",
  assessment:
    "The subsequent viewport exposes the full first row through ordinary scrolling.",
};
const answer = {
  ...observations,
  canary: "030303",
  classification: "NORMAL_VIEWPORT_CONTINUATION",
  defects: [],
};
describe("one scoped independent review of a scrolling viewport", () => {
  it("binds to a unique authentic block, full original, separate continuation, and ordered horizontal pixels", () => {
    const seen = new Set<string>();
    expect(originalBlock(batch, challenge, hash(4), file, seen).start).toBe(0);
    expect(
      boundaryEvidence(evidence, challenge, hash(4), file).horizontalViews,
    ).toHaveLength(1);
    expect(
      verifyJudgment(answer, "030303", seen, "independent-id").classification,
    ).toBe("NORMAL_VIEWPORT_CONTINUATION");
    expect(() =>
      verifyJudgment(answer, "030303", seen, "one-request"),
    ).toThrow();
  });
  it("never reclassifies a chart, missing glyphs, additional defects, an unrelated mobile issue, invalid calibration or a print page", () => {
    for (const defects of [
      ["Axis labels overlap in the chart."],
      ["Two table columns overlap at the screen bottom."],
      ["Cut off table at bottom.", "Missing glyphs."],
    ]) {
      expect(() =>
        originalBlock(
          { ...batch, images: [{ ...batch.images[0], defects }] },
          challenge,
          hash(4),
          file,
          new Set(),
        ),
      ).toThrow();
    }
    expect(() =>
      originalBlock(
        { ...batch, canaryReceived: "000000" },
        challenge,
        hash(4),
        file,
        new Set(),
      ),
    ).toThrow();
    expect(() =>
      originalBlock(batch, challenge, hash(4), "qa/zh-page-4.png", new Set()),
    ).toThrow();
  });
  it("refuses substituted images, invalid paths, incorrect ordering, duplicate pixels or mismatched paper hashes", () => {
    for (const bad of [
      { ...evidence, contentSha256: hash(9) },
      { ...evidence, original: { ...evidence.original, sha256: hash(9) } },
      {
        ...evidence,
        continuation: { ...evidence.continuation, file: "../../x.png" },
      },
      { ...evidence, continuation: evidence.original },
      {
        ...evidence,
        horizontalViews: [
          { file: "boundary-zh-390-viewport-pan-2.png", sha256: hash(9) },
        ],
      },
      {
        ...evidence,
        horizontalViews: [
          {
            ...evidence.horizontalViews[0],
            sha256: evidence.continuation.sha256,
          },
        ],
      },
    ])
      expect(() => boundaryEvidence(bad, challenge, hash(4), file)).toThrow();
  });
  it("retains a persistent or indeterminate finding and rejects any inconsistent or reused evidence", () => {
    for (const classification of ["PERSISTENT_DEFECT", "INDETERMINATE"]) {
      expect(
        verifyJudgment(
          {
            ...answer,
            classification,
            defects: ["Missing final table column."],
          },
          "030303",
          new Set(),
          "new-id",
        ).classification,
      ).toBe(classification);
      expect(() =>
        verifyJudgment(
          { ...answer, classification },
          "030303",
          new Set(),
          "new-id",
        ),
      ).toThrow();
    }
    expect(() =>
      verifyJudgment(
        { ...answer, defects: ["Visible defect."] },
        "030303",
        new Set(),
        "new-id",
      ),
    ).toThrow();
    expect(() =>
      verifyJudgment(answer, "030304", new Set(), "new-id"),
    ).toThrow();
    expect(() =>
      verifyJudgment(answer, "030303", new Set(["030303"]), "new-id"),
    ).toThrow();
  });
});
