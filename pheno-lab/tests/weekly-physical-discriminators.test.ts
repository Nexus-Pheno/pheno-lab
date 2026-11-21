import { expect, it } from "vitest";
import { assertPhysicalDiscriminators } from "../scripts/weekly-manuscript/signature-measurements";

const physical = {
  quantity: { en: "Wet-film thickness variation", zh: "湿膜厚度变化" },
  unit: { en: "µm", zh: "微米" },
  expectedChange: { en: "Lower variation", zh: "波动减小" },
};
const electrical = {
  quantity: { en: "Stabilized PCE", zh: "稳态 PCE" },
  unit: { en: "%", zh: "%" },
  expectedChange: { en: "Higher average", zh: "平均值较高" },
};
const measurement = {
  en: "Map wet-film thickness at matched fixed times alongside PCE",
  zh: "在统一延时测量湿膜厚度分布，同时测量 PCE",
};
it("allows a direct proposed film readout alongside device results", () => {
  expect(() =>
    assertPhysicalDiscriminators(
      { preferredCause: electrical, alternativeCause: physical },
      measurement,
    ),
  ).not.toThrow();
});
it("rejects assigning PCE SD to a wet-film quantity in either language", () => {
  for (const lang of ["en", "zh"] as const) {
    const alternativeCause = {
      ...physical,
      unit: { ...physical.unit, [lang]: "PCE SD" },
    };
    expect(() =>
      assertPhysicalDiscriminators(
        { preferredCause: electrical, alternativeCause },
        measurement,
      ),
    ).toThrow(/its own unit/);
  }
});
it("asks for the actual film readout when the proposed discriminator is only electrical", () => {
  expect(() =>
    assertPhysicalDiscriminators(
      { preferredCause: electrical, alternativeCause: physical },
      { en: "Measure PCE and FF", zh: "记录 PCE 和 FF" },
    ),
  ).toThrow(/alongside/);
});
