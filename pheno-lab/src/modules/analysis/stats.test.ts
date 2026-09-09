import { describe, expect, it } from "vitest";
import {
  compareByCondition,
  detectAnomalies,
  perExperimentOutcomes,
  summarize,
  topCombos,
  untriedCombos,
  winCounts,
} from "./stats";
import type { TidyRow } from "./dataset";

const row = (
  over: Partial<TidyRow> & {
    conditions: Record<string, string>;
    pce?: number;
  },
): TidyRow => ({
  experimentId: over.experimentCode ?? "e1",
  experimentCode: over.experimentCode ?? "E-1",
  experimentTitle: over.experimentTitle ?? "Test",
  projectName: null,
  createdBy: "Tech",
  date: over.date ?? "2026-09-01",
  sampleId: over.sampleCode ?? "s",
  sampleCode: over.sampleCode ?? "E-1-S1",
  group: over.group ?? "A",
  isControl: false,
  conditions: over.conditions,
  metrics: over.pce === undefined ? {} : { pce: over.pce },
});

describe("summarize", () => {
  it("describes a spread without pretending to a deviation it cannot have", () => {
    const s = summarize([1, 2, 3, 4])!;
    expect(s.n).toBe(4);
    expect(s.mean).toBe(2.5);
    expect(s.median).toBe(2.5);
    expect(s.best).toBe(4);
    expect(s.worst).toBe(1);
    expect(summarize([7])!.sd).toBe(0);
    expect(summarize([])).toBeNull();
  });
});

describe("compareByCondition", () => {
  const rows = [
    row({ conditions: { coat: "spin" }, pce: 20, sampleCode: "A1" }),
    row({ conditions: { coat: "spin" }, pce: 22, sampleCode: "A2" }),
    row({
      conditions: { coat: "blade" },
      pce: 18,
      sampleCode: "B1",
      experimentCode: "E-2",
    }),
    // No measurement: present in the plan, absent from the comparison.
    row({ conditions: { coat: "blade" }, sampleCode: "B2" }),
  ];

  it("pools samples by condition value across experiments, best mean first", () => {
    const arms = compareByCondition(rows, "coat", "pce");
    expect(arms.map((a) => a.value)).toEqual(["spin", "blade"]);
    expect(arms[0].summary.mean).toBe(21);
    expect(arms[0].summary.n).toBe(2);
    expect(arms[1].summary.n).toBe(1);
    expect(arms[1].experiments).toEqual(["E-2"]);
  });

  it("ignores a condition the row never carried", () => {
    expect(compareByCondition(rows, "anneal", "pce")).toEqual([]);
  });
});

describe("perExperimentOutcomes", () => {
  const rows = [
    // E-1 compares both values; blade wins there.
    row({ conditions: { coat: "spin" }, pce: 18, experimentCode: "E-1" }),
    row({ conditions: { coat: "blade" }, pce: 20, experimentCode: "E-1" }),
    // E-2 compares both; blade wins again.
    row({
      conditions: { coat: "spin" },
      pce: 19,
      experimentCode: "E-2",
      date: "2026-09-02",
    }),
    row({
      conditions: { coat: "blade" },
      pce: 21,
      experimentCode: "E-2",
      date: "2026-09-02",
    }),
    // E-3 only ran one value — not a comparison.
    row({ conditions: { coat: "spin" }, pce: 30, experimentCode: "E-3" }),
  ];

  it("keeps only the batches that actually compared two values", () => {
    const outcomes = perExperimentOutcomes(rows, "coat", "pce");
    expect(outcomes.map((o) => o.experimentCode)).toEqual(["E-1", "E-2"]);
    expect(outcomes.every((o) => o.winner === "blade")).toBe(true);
  });

  it("counts wins per batch, which is the evidence pooling cannot give", () => {
    const wins = winCounts(perExperimentOutcomes(rows, "coat", "pce"));
    expect(wins[0]).toEqual({ value: "blade", wins: 2, appearances: 2 });
    expect(wins[1]).toEqual({ value: "spin", wins: 0, appearances: 2 });
  });
});

describe("topCombos", () => {
  it("ranks recipes run at least twice and drops the one-offs", () => {
    const rows = [
      row({ conditions: { coat: "spin", anneal: "100" }, pce: 20 }),
      row({ conditions: { coat: "spin", anneal: "100" }, pce: 22 }),
      row({ conditions: { coat: "blade", anneal: "100" }, pce: 25 }),
      row({ conditions: { coat: "spin", anneal: "150" }, pce: 10 }),
      row({ conditions: { coat: "spin", anneal: "150" }, pce: 12 }),
    ];
    const combos = topCombos(rows, ["coat", "anneal"], "pce");
    // blade/100 has the single best device but only one device: excluded.
    expect(combos).toHaveLength(2);
    expect(combos[0].conditions).toEqual({ coat: "spin", anneal: "100" });
    expect(combos[0].summary.mean).toBe(21);
    expect(combos[1].summary.mean).toBe(11);
  });

  it("skips rows missing any part of the combination", () => {
    const rows = [
      row({ conditions: { coat: "spin" }, pce: 20 }),
      row({ conditions: { coat: "spin" }, pce: 21 }),
    ];
    expect(topCombos(rows, ["coat", "anneal"], "pce")).toEqual([]);
  });
});

describe("untriedCombos", () => {
  it("lists the pairs the lab has never run together", () => {
    const rows = [
      row({ conditions: { coat: "spin", anneal: "100" }, pce: 20 }),
      row({ conditions: { coat: "blade", anneal: "150" }, pce: 21 }),
    ];
    expect(untriedCombos(rows, "coat", "anneal")).toEqual([
      { a: "blade", b: "100" },
      { a: "spin", b: "150" },
    ]);
  });
});

describe("detectAnomalies", () => {
  const measured = (code: string, pce: number, group = "A") =>
    ({ sampleCode: code, group, metrics: { pce } }) as const;

  it("names the champion device", () => {
    const flags = detectAnomalies([measured("S1", 20), measured("S2", 24)]);
    expect(flags[0]).toEqual({
      kind: "champion",
      sample: "S2",
      group: "A",
      value: 24,
    });
  });

  it("flags negative resistance as an artifact, not a device property", () => {
    const flags = detectAnomalies(
      [measured("S1", 20)],
      [
        {
          serial: "SR-1",
          metrics: { rsh: -120, rs: 4 },
          sample: { code: "S1", variationGroup: "A" },
        },
      ],
    );
    expect(flags).toContainEqual({
      kind: "negativeResistance",
      sample: "S1",
      metric: "Rsh",
      value: -120,
    });
    // A positive Rs is normal and must not be flagged.
    expect(
      flags.some((f) => f.kind === "negativeResistance" && f.metric === "Rs"),
    ).toBe(false);
  });

  it("catches a device outside its group's fences and spares a tight group", () => {
    const outliers = detectAnomalies([
      measured("S1", 20),
      measured("S2", 20.2),
      measured("S3", 20.1),
      measured("S4", 5),
    ]).filter((f) => f.kind === "outlier");
    expect(outliers).toHaveLength(1);
    expect(outliers[0]).toMatchObject({ sample: "S4", group: "A" });

    const tight = detectAnomalies([
      measured("S1", 20),
      measured("S2", 20.1),
      measured("S3", 20.2),
      measured("S4", 20.3),
    ]).filter((f) => f.kind === "outlier");
    expect(tight).toHaveLength(0);
  });

  it("does not judge a group too small to have a range", () => {
    const flags = detectAnomalies([
      measured("S1", 20),
      measured("S2", 2),
      measured("S3", 21),
    ]).filter((f) => f.kind === "outlier");
    expect(flags).toHaveLength(0);
  });
});
