import { describe, expect, it } from "vitest";
import {
  analysisTextProjection,
  containsRestrictedAnalysisText,
  projectAnalysisPayload,
} from "@/modules/experiments/summary-projection";
describe("AI result interpretation privacy projection", () => {
  it("keeps named material, dose and process contrasts", () => {
    const text = "PDADI 0.4 mg/mL; EtOH:DMF=1:1; normal versus coanneal";
    expect(analysisTextProjection(text)).toBe(text);
  });
  it("withholds registered private notation even when no label is present", () => {
    expect(
      analysisTextProjection("Compare candidate c1ccccc1 at fixed dose", [
        "c1ccccc1",
      ]),
    ).toContain("omitted");
    expect(
      containsRestrictedAnalysisText("A proposed C1CCCCC1 candidate"),
    ).toBe(true);
  });
  it("withholds explicit full formulations and molecular payload keys", () => {
    expect(
      analysisTextProjection("Recipe: proprietary complete components"),
    ).toContain("omitted");
    expect(analysisTextProjection("SMILES: CCN(CC)CC")).toContain("omitted");
    expect(
      projectAnalysisPayload({
        name: "Candidate",
        composition: "hidden",
        ingredients: ["hidden"],
        actuals: { formula: "hidden" },
        source: { smiles: "hidden" },
      }),
    ).toEqual({ name: "Candidate", source: {} });
  });
  it("withholds whole formulation condition rows and multi-component narrative recipes", () => {
    const formula = "FAI 1 M; PbI2 1.1 M; CsI 0.1 M; DMSO 20 vol%";
    expect(
      JSON.stringify(
        projectAnalysisPayload({
          parameterName: "Perovskite formulation",
          values: { A: formula },
        }),
      ),
    ).not.toContain("FAI");
    expect(analysisTextProjection(formula)).toContain("omitted");
  });
  it("omits absorber precursor ingredient lists even when separate rows look harmless", () => {
    const source = {
      process: "Blade coating",
      layer: "PVK",
      materials: [
        { name: "FAI", amount: "1 M" },
        { name: "PbI2", amount: "1.1 M" },
      ],
      parameters: [
        { parameterName: "Coating speed", value: "8", unit: "mm/s" },
      ],
    };
    const projected = JSON.stringify(projectAnalysisPayload(source));
    expect(projected).not.toContain("FAI");
    expect(projected).not.toContain("PbI2");
    expect(projected).toContain("Coating speed");
    expect(
      JSON.stringify(
        projectAnalysisPayload({
          layer: "HTL",
          materials: [{ name: "Candidate SAM", amount: "0.3 mg/mL" }],
        }),
      ),
    ).toContain("Candidate SAM");
  });
  it("removes HTML structures and detailed raw tables", () => {
    expect(containsRestrictedAnalysisText('<svg viewBox="0 0 10 10">')).toBe(
      true,
    );
    expect(
      analysisTextProjection(
        "Purpose <table><tr><td>raw recipe</td></tr></table> comparison",
      ),
    ).not.toContain("raw recipe");
  });
});
