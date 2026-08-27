import { describe, expect, it } from "vitest";
import {
  buildCaptureChoiceCatalog,
  captureChoiceKey,
  captureFieldKind,
  materialCardsForStep,
  materialSelectionForValues,
  selectOptionsForParameter,
} from "./capture-fields";

const parameter = (
  name: string,
  unit = "",
  source = "process",
  value = "",
) => ({ name, unit, source, value, variations: [] });

describe("capture field controls", () => {
  it("uses material cards for every material-source test-plan field", () => {
    expect(captureFieldKind(parameter("HTL Material", "", "material"))).toBe(
      "material",
    );
  });

  it.each([
    "Treatment type",
    "Drying methods",
    "Solvent sequence",
    "Gas",
    "Antisolvent",
    "Power type",
    "Precursor A",
    "Scribe line",
    "Encapsulant",
    "Cover",
    "Cure method",
    "Edge sealant",
    "SAM工艺",
    "SAM溶剂",
    "钙钛矿配方",
    "钙钛矿体相添加剂",
    "钙钛矿体相钝化剂",
  ])("renders categorical field %s as a dropdown", (name) => {
    expect(captureFieldKind(parameter(name))).toBe("select");
  });

  it.each([
    ["Duration", "min"],
    ["Power", "W"],
    ["Number of passes", ""],
    ["Cycles", ""],
    ["Magnification", ""],
  ])("keeps measured parameter %s editable", (name, unit) => {
    expect(captureFieldKind(parameter(name, unit))).toBe("text");
  });

  it("combines process, equipment, preset, and planned choices without duplicates", () => {
    const catalog = buildCaptureChoiceCatalog([
      {
        id: "surface",
        parameters: [
          {
            name: "Treatment type",
            unit: "",
            defaultValue: "UV-Ozone",
            options: ["Oxygen plasma"],
          },
        ],
        equipment: [
          {
            parameters: [
              {
                name: "Treatment type",
                unit: "",
                defaultValue: "UV-Ozone",
              },
            ],
          },
        ],
        presets: [
          {
            payload: {
              parameters: [{ name: "Treatment type", value: "Air plasma" }],
            },
          },
        ],
      },
    ]);
    const options = selectOptionsForParameter(
      "surface",
      {
        ...parameter("Treatment type", "", "process", "UV-Ozone"),
        variations: [{ value: "Air plasma" }],
      },
      catalog,
    );
    expect(catalog[captureChoiceKey("surface", "Treatment type")]).toEqual([
      "UV-Ozone",
      "Oxygen plasma",
      "Air plasma",
    ]);
    expect(options).toEqual(["UV-Ozone", "Oxygen plasma", "Air plasma"]);
  });

  it("filters material cards by layer while retaining planned cards", () => {
    const materials = [
      { id: "sam", name: "SAM A", processId: "blade", category: "SAM" },
      {
        id: "legacy",
        name: "Legacy SAM",
        processId: "blade",
        category: "OTHER",
      },
      {
        id: "precursor",
        name: "PbI2",
        processId: "spin",
        category: "PRECURSOR",
      },
    ];
    expect(
      materialCardsForStep({
        processId: "blade",
        layer: "HTL",
        linkedMaterialIds: [],
        plannedNames: ["Legacy SAM"],
        materials,
        categoryLayers: [{ code: "SAM", layers: ["HTL"] }],
      }).map((material) => material.id),
    ).toEqual(["legacy", "sam"]);
  });

  it("restores a material selection from the stored card or planned name", () => {
    const params = [parameter("Material", "", "material", "SAM A")];
    const materials = [
      { id: "sam", name: "SAM A", processId: "blade", category: "SAM" },
    ];
    expect(
      materialSelectionForValues(params, { Material: "SAM A" }, {}, materials),
    ).toEqual({
      Material: "sam",
    });
  });
});
