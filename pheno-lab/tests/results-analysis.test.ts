import { describe, expect, it } from "vitest";
import type { TestPlan } from "@/lib/library";
import {
  analyzeResultPlots,
  describeResultConditions,
} from "@/modules/experiments/results-analysis";

const step = (id: string, layer: string) => ({
  id,
  name: "刮涂",
  processId: "blade",
  process: { name: "Blade coating" },
  layer,
  equipmentId: "coater",
  equipment: { name: "Blade coater", nickname: "Coater 1" },
  materials: [{ material: { name: "Passivant" }, amount: "1 mg" }],
  parameters: [
    {
      id: `${id}-concentration`,
      name: "浓度",
      unit: "mg/ml",
      value: "",
      source: "process",
      variations: [
        { variationGroup: "A", value: "0.5" },
        { variationGroup: "B", value: "1" },
      ],
    },
  ],
});
const variable = {
  kind: "parameter" as const,
  processId: "blade",
  parameter: "浓度",
  unit: "mg/ml",
  values: { A: "0.5", B: "2" },
};
const plan = (variables: TestPlan["variables"]): TestPlan => ({
  groups: [],
  variables,
});

describe("result condition meanings", () => {
  it("joins the plan to the specific layer and equipment without merging repeated process steps", () => {
    const conditions = describeResultConditions(
      [step("top", "TOP"), step("bottom", "BOTTOM")],
      plan([{ ...variable, layer: "TOP", equipmentId: "coater" }]),
      [{ code: "TOP", name: "Top passivation" }],
    );
    expect(conditions).toHaveLength(2);
    expect(conditions[0]).toMatchObject({
      process: "刮涂",
      layer: "Top passivation",
      equipment: "Coater 1",
      materials: ["Passivant 1 mg"],
      values: { A: "0.5", B: "1" },
      plannedValues: { A: "0.5", B: "2" },
      plannedOnly: false,
    });
    expect(conditions[1].plannedValues).toBeNull();
  });

  it("does not guess a step when a plan variable matches two layers", () => {
    const conditions = describeResultConditions(
      [step("top", "TOP"), step("bottom", "BOTTOM")],
      plan([variable]),
      [],
    );
    expect(conditions).toHaveLength(3);
    expect(conditions.slice(0, 2).every((item) => !item.plannedValues)).toBe(
      true,
    );
    expect(conditions[2]).toMatchObject({
      plannedOnly: true,
      process: "",
      values: variable.values,
    });
  });

  it("retains plan-only conditions and legacy plans without variables", () => {
    expect(describeResultConditions([], plan([variable]), [])[0]).toMatchObject(
      {
        name: "浓度",
        plannedOnly: true,
      },
    );
    expect(
      describeResultConditions(
        [step("top", "TOP")],
        { groups: [] } as unknown as TestPlan,
        [],
      ),
    ).toHaveLength(1);
    expect(describeResultConditions([], undefined, [])).toEqual([]);
  });
});

describe("analysis of current plotted results", () => {
  const plot = (metric: string, values: number[][]) => ({
    metric,
    groups: values.map((items, index) => ({
      label: String.fromCharCode(65 + index),
      values: items.map((value, item) => ({ value, code: `S${item}` })),
    })),
  });

  it("computes per-metric sample counts, spread and absolute control differences including zero", () => {
    const [pce, ff] = analyzeResultPlots(
      [
        plot("PCE (%)", [
          [0, 2],
          [3, 5],
        ]),
        plot("FF (%)", [[70], [80, 82]]),
      ],
      "A",
    );
    expect(pce.groups[0].summary).toMatchObject({
      n: 2,
      mean: 1,
      median: 1,
      worst: 0,
      best: 2,
    });
    expect(pce.groups[1].delta).toBe(3);
    expect(ff.groups[1].delta).toBe(11);
    expect(pce.highest.map((group) => group.label)).toEqual(["B"]);
  });

  it("keeps ties and does not manufacture control comparisons or empty-group values", () => {
    const [analysis] = analyzeResultPlots(
      [plot("Voc (V)", [[1], [1], []])],
      "C",
    );
    expect(analysis.highest.map((group) => group.label)).toEqual(["A", "B"]);
    expect(analysis.groups.map((group) => group.delta)).toEqual([
      null,
      null,
      null,
    ]);
    expect(analysis.groups[2].summary).toBeNull();
  });

  it("excludes nonfinite values and unrequested metrics without modifying the plots", () => {
    const plots = [
      plot("Jsc", [[NaN, Infinity, -Infinity, 20], []]),
      plot("Rsh", [[999]]),
    ];
    const analysis = analyzeResultPlots(plots, undefined);
    expect(analysis).toHaveLength(1);
    expect(analysis[0].groups[0].summary).toMatchObject({ n: 1, mean: 20 });
    expect(analysis[0].groups[1].summary).toBeNull();
    expect(plots[0].groups[0].values).toHaveLength(4);
    expect(
      analyzeResultPlots([plot("PCE", [[], []])], undefined)[0].highest,
    ).toEqual([]);
  });
});
