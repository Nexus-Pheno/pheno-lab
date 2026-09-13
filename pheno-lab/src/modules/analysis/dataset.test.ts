import { describe, expect, it } from "vitest";
import { buildTidyRows, recipeConditions, variedConditions } from "./dataset";

const process = { id: "p-coat", name: "Blade coating" };
const anneal = { id: "p-anneal", name: "Anneal" };

const exp = (over: Record<string, unknown>) => ({
  id: "e1",
  code: "E-1",
  title: "One",
  createdAt: new Date("2026-09-01T02:00:00Z"),
  createdBy: { name: "Tech" },
  project: null,
  metadata: null,
  steps: [],
  samples: [],
  ...over,
});

describe("recipeConditions", () => {
  it("turns each step's materials and constant parameters into conditions", () => {
    const conditions = recipeConditions(
      exp({
        steps: [
          {
            name: "HTL",
            process,
            materials: [
              { material: { name: "PEACl" } },
              { material: { name: "CDCA" } },
            ],
            parameters: [
              { name: "Speed", unit: "mm/s", value: "10", variations: [] },
              { name: "Gap", unit: "µm", value: "", variations: [] },
            ],
          },
        ],
      }),
    );
    expect(conditions.map((c) => [c.label, c.value])).toEqual([
      ["Material", "CDCA + PEACl"],
      ["Speed", "10"],
    ]);
    expect(conditions.every((c) => c.source === "recipe")).toBe(true);
  });

  it("leaves varied parameters to variedConditions", () => {
    const e = exp({
      steps: [
        {
          name: "HTL",
          process,
          materials: [],
          parameters: [
            {
              name: "Speed",
              unit: "",
              value: "10",
              variations: [
                { variationGroup: "A", value: "10" },
                { variationGroup: "B", value: "20" },
              ],
            },
          ],
        },
      ],
    });
    expect(recipeConditions(e)).toEqual([]);
    expect(variedConditions(e).map((c) => c.byGroup)).toEqual([
      { A: "10", B: "20" },
    ]);
  });

  it("merges two steps of the same process into one recipe line", () => {
    const conditions = recipeConditions(
      exp({
        steps: [
          {
            name: "a",
            process,
            materials: [{ material: { name: "X" } }],
            parameters: [],
          },
          {
            name: "b",
            process,
            materials: [{ material: { name: "Y" } }],
            parameters: [],
          },
        ],
      }),
    );
    expect(conditions[0].value).toBe("X + Y");
  });
});

describe("buildTidyRows with recipes", () => {
  const two = [
    exp({
      id: "e1",
      code: "E-1",
      steps: [
        {
          name: "HTL",
          process,
          materials: [{ material: { name: "PEACl" } }],
          parameters: [],
        },
        {
          name: "Anneal",
          process: anneal,
          materials: [],
          parameters: [
            { name: "Temp", unit: "C", value: "100", variations: [] },
          ],
        },
      ],
      samples: [
        {
          id: "s1",
          code: "S1",
          variationGroup: "A",
          results: [{ metrics: { "PCE (%)": "20" } }],
        },
      ],
    }),
    exp({
      id: "e2",
      code: "E-2",
      steps: [
        {
          name: "HTL",
          process,
          materials: [{ material: { name: "CDCA" } }],
          parameters: [],
        },
        {
          name: "Anneal",
          process: anneal,
          materials: [],
          parameters: [
            { name: "Temp", unit: "C", value: "100", variations: [] },
          ],
        },
      ],
      samples: [
        {
          id: "s2",
          code: "S1",
          variationGroup: "A",
          results: [{ metrics: { "PCE (%)": "22" } }],
        },
      ],
    }),
  ];

  it("lines the same slot up across experiments so recipes become comparable", () => {
    const rows = buildTidyRows(two, { recipe: true });
    expect(rows).toHaveLength(2);
    const key = Object.keys(rows[0].conditions).find((k) =>
      k.startsWith("p-coat::"),
    )!;
    expect(rows[0].conditions[key]).toBe("PEACl");
    expect(rows[1].conditions[key]).toBe("CDCA");
    // The shared constant is carried too — the catalog drops it later
    // because it never takes two values.
    expect(rows[0].conditions["p-anneal::temp"]).toBe("100");
  });

  it("keeps the old behaviour when recipes are not requested", () => {
    const rows = buildTidyRows(two);
    expect(rows[0].conditions).toEqual({});
  });
});
