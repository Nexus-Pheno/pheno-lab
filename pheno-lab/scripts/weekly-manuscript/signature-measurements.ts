// Catch a clear dimensional substitution before a manuscript goes to the
// independent scientist. Unfamiliar measurements still require scientific review.
type Bilingual = { en: string; zh: string };
type Signature = {
  quantity: Bilingual;
  unit: Bilingual;
  expectedChange: Bilingual;
};

const filmQuantity =
  /(?:wet[- ]film|film|coat(?:ing)?|drying|surface).{0,32}(?:uniform|thickness|coverage|drying)|(?:uniformity|coverage|thickness).{0,24}(?:film|coating)|湿膜|膜厚|覆盖率|成膜均匀|涂层均匀|干燥均匀/i;
const electricalValue =
  /\b(?:PCE|FF|Jsc|Voc)\b|efficienc|photovoltaic|功率转换效率|器件效率/i;
const electricalOnly =
  /\b(?:PCE|FF|Jsc|Voc)\b|device.{0,20}(?:spread|SD|deviation)|器件间标准差|器件离散/i;
const filmReadout =
  /(?:µm|μm|\bnm\b|micromet|nanomet|微米|纳米|seconds?|秒|coverage\s*(?:fraction|%)|面积占比|膜内.{0,8}(?:CV|变异系数)|within-film\s+CV)/i;

export function assertPhysicalDiscriminators(
  signatures: { preferredCause: Signature; alternativeCause: Signature },
  discriminator: Bilingual,
) {
  for (const signature of [
    signatures.preferredCause,
    signatures.alternativeCause,
  ]) {
    for (const lang of ["en", "zh"] as const) {
      if (!filmQuantity.test(signature.quantity[lang])) continue;
      if (
        electricalOnly.test(signature.unit[lang]) &&
        !filmReadout.test(signature.unit[lang])
      ) {
        throw Error(
          "Film thickness, drying or coverage requires a physical readout with its own unit. Device PCE spread does not measure film uniformity.",
        );
      }
      if (
        electricalValue.test(discriminator[lang]) &&
        !filmQuantity.test(discriminator[lang]) &&
        !filmReadout.test(discriminator[lang])
      ) {
        throw Error(
          "State where, when and how the proposed film readout will be measured alongside device measurements in both languages.",
        );
      }
    }
  }
}
