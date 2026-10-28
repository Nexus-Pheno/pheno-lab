/** The provider receives a deliberately small interpretation payload, never raw recipes/graphs. */
const markers =
  /(?:SMILES|InChI|canonicalSmiles|<svg|<img|data:image|molecular\s+(?:formula|structure)|raw\s+recipe|配方组成|组分比例|分子式|化学结构|分子结构)/i;
const rawRecipe = /(?:recipe|formulation|配方|组分)\s*[:：=]/i;
const molecularToken =
  /(?:^|[\s"'=:`])(?=[A-Za-z0-9@+\-()[\]#=.\/\\]*[0-9=#@\[\]])(?:Br|Cl|Si|[BCNOPSFIbcnosp]|\[[^\]\s]+\]|\d|[()=#@+\-\/\\]){6,}(?=$|[\s"'`,;])/;
const formulationParameter =
  /(?:recipe|formulation|stoichiometr|composition|ingredient|配方|组分|成分|组成|分子式|smiles)/i;
const molarIngredients =
  /(?:[A-Z][a-z]?\d*){2,}\s*\d+(?:\.\d+)?\s*(?:mM|M|mol\b|vol%)/g;
const stoichiometry = /(?:Cs|FA|MA|Pb|Sn|Br|Cl)0\.\d+(?:[A-Za-z0-9().]+){3,}/;
export function containsRestrictedAnalysisText(
  value: string,
  privateNotations: string[] = [],
) {
  const compact = value.replace(/\s+/g, "");
  return (
    markers.test(value) ||
    rawRecipe.test(value) ||
    (value.match(molarIngredients)?.length ?? 0) >= 2 ||
    molecularToken.test(value) ||
    stoichiometry.test(value) ||
    privateNotations.some(
      (n) => n.length >= 3 && compact.includes(n.replace(/\s+/g, "")),
    )
  );
}
export function analysisTextProjection(
  value: unknown,
  privateNotations: string[] = [],
) {
  if (typeof value !== "string") return value;
  const plain = value
    .replace(/<table\b[\s\S]*?<\/table>/gi, " [Detailed table withheld] ")
    .replace(/<[^>]*>/g, " ");
  return plain
    .split(/\n|(?<=[.!?。！？])\s+/)
    .map((line) =>
      containsRestrictedAnalysisText(line, privateNotations)
        ? "[Restricted chemistry or formulation omitted; consult the authorized source record.]"
        : line,
    )
    .join("\n");
}
export function projectAnalysisPayload(
  value: unknown,
  privateNotations: string[] = [],
): unknown {
  if (typeof value === "string")
    return analysisTextProjection(value, privateNotations);
  if (Array.isArray(value))
    return value.map((v) => projectAnalysisPayload(v, privateNotations));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const parameter = record.parameterName ?? record.name;
    if (typeof parameter === "string" && formulationParameter.test(parameter))
      return {
        condition:
          "[Restricted formulation omitted; consult the authorized source record.]",
      };
    const layer = typeof record.layer === "string" ? record.layer : "";
    const process = typeof record.process === "string" ? record.process : "";
    const materialContextAllowed =
      !/PVK|perovskite|absorber|钙钛矿|吸收层/i.test(layer) &&
      /^(?:HTL|SAM|PASS(?:_|$)|钝化|自组装)/i.test(layer || process);
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "materials" || materialContextAllowed)
        .filter(
          ([key]) =>
            !/^(?:smiles|canonicalSmiles|recipePayload|ingredients|composition|structure|descriptors|actuals)$/i.test(
              key,
            ),
        )
        .map(([key, v]) => [key, projectAnalysisPayload(v, privateNotations)]),
    );
  }
  return value;
}
