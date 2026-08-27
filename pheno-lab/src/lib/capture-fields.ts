export type CaptureFieldKind = "text" | "select" | "material";

export type CaptureFieldParameter = {
  name: string;
  unit: string;
  value: string;
  source: string;
  variations: { value: string }[];
};

export type CaptureMaterialCard = {
  id: string;
  name: string;
  processId: string | null;
  category: string;
};

export type CaptureCategoryLayers = {
  code: string;
  layers: string[];
};

const categoricalFieldPatterns = [
  /\b(?:type|method|methods|mode|sequence|gas|solvent|antisolvent|precursor|scribe line|encapsulant|cover|sealant|spectrum|direction|source|model|atmosphere|supply|heating|control|laser|targets?|classification|bias light)\b/i,
  /(?:工艺|溶剂|配方|添加剂|钝化剂|处理方式|气体|材料)$/u,
];

const uniqueNonEmpty = (values: string[]) => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    const key = value.toLocaleLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
};

export const captureChoiceKey = (processId: string, fieldName: string) =>
  `${processId}:${fieldName.trim().toLocaleLowerCase()}`;

type CaptureChoiceProcess = {
  id: string;
  parameters: unknown;
  equipment: { parameters: unknown }[];
  presets: { payload: unknown }[];
};

const objectRows = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter(
        (row): row is Record<string, unknown> =>
          typeof row === "object" && row !== null,
      )
    : [];

/** Build the allowed categorical values already defined by the process cards. */
export function buildCaptureChoiceCatalog(
  processes: CaptureChoiceProcess[],
): Record<string, string[]> {
  const catalog: Record<string, string[]> = {};
  const add = (processId: string, name: unknown, values: unknown[]) => {
    if (typeof name !== "string" || !name.trim()) return;
    const key = captureChoiceKey(processId, name);
    catalog[key] = uniqueNonEmpty([
      ...(catalog[key] ?? []),
      ...values.filter((value): value is string => typeof value === "string"),
    ]);
  };
  const addDefinitions = (processId: string, value: unknown) => {
    for (const definition of objectRows(value)) {
      add(processId, definition.name, [
        definition.defaultValue,
        ...((Array.isArray(definition.options)
          ? definition.options
          : []) as unknown[]),
      ]);
    }
  };

  for (const process of processes) {
    addDefinitions(process.id, process.parameters);
    for (const equipment of process.equipment) {
      addDefinitions(process.id, equipment.parameters);
    }
    for (const preset of process.presets) {
      const payload =
        typeof preset.payload === "object" && preset.payload !== null
          ? (preset.payload as Record<string, unknown>)
          : {};
      for (const parameter of objectRows(payload.parameters)) {
        add(process.id, parameter.name, [parameter.value]);
      }
    }
  }
  return catalog;
}

/**
 * Capture inputs have three semantics:
 * - test-plan material variables select a real Material card;
 * - categorical, unitless fields select a canonical process choice;
 * - measured process parameters remain editable text/number-like values.
 */
export function captureFieldKind(
  parameter: Pick<CaptureFieldParameter, "name" | "unit" | "source">,
): CaptureFieldKind {
  if (parameter.source === "material") return "material";
  if (parameter.unit.trim()) return "text";
  return categoricalFieldPatterns.some((pattern) =>
    pattern.test(parameter.name),
  )
    ? "select"
    : "text";
}

export function selectOptionsForParameter(
  processId: string,
  parameter: CaptureFieldParameter,
  catalog: Record<string, string[]>,
  currentValue = "",
): string[] {
  return uniqueNonEmpty([
    ...(catalog[captureChoiceKey(processId, parameter.name)] ?? []),
    parameter.value,
    ...parameter.variations.map((variation) => variation.value),
    currentValue,
  ]);
}

export function materialCardsForStep({
  processId,
  layer,
  linkedMaterialIds,
  plannedNames,
  materials,
  categoryLayers,
}: {
  processId: string;
  layer: string;
  linkedMaterialIds: string[];
  plannedNames: string[];
  materials: CaptureMaterialCard[];
  categoryLayers: CaptureCategoryLayers[];
}): CaptureMaterialCard[] {
  const categoryCodes = new Set(
    categoryLayers
      .filter((category) => layer && category.layers.includes(layer))
      .map((category) => category.code),
  );
  const eligible =
    categoryCodes.size > 0
      ? materials.filter((material) => categoryCodes.has(material.category))
      : materials.filter((material) => material.processId === processId);

  const selected = new Map(eligible.map((material) => [material.id, material]));
  for (const id of linkedMaterialIds) {
    const material = materials.find((candidate) => candidate.id === id);
    if (material) selected.set(material.id, material);
  }
  for (const name of plannedNames) {
    const material = materials.find(
      (candidate) =>
        candidate.name.localeCompare(name, undefined, {
          sensitivity: "accent",
        }) === 0,
    );
    if (material) selected.set(material.id, material);
  }

  const priorityNames = new Set(
    plannedNames.map((name) => name.trim().toLocaleLowerCase()),
  );
  return [...selected.values()].sort((a, b) => {
    const aPriority = priorityNames.has(a.name.trim().toLocaleLowerCase());
    const bPriority = priorityNames.has(b.name.trim().toLocaleLowerCase());
    if (aPriority !== bPriority) return aPriority ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export function materialSelectionForValues(
  parameters: CaptureFieldParameter[],
  values: Record<string, string>,
  existing: Record<string, string>,
  materials: CaptureMaterialCard[],
): Record<string, string> {
  const selection: Record<string, string> = {};
  for (const parameter of parameters) {
    if (captureFieldKind(parameter) !== "material") continue;
    const explicitId = existing[parameter.name];
    if (
      explicitId &&
      materials.some((material) => material.id === explicitId)
    ) {
      selection[parameter.name] = explicitId;
      continue;
    }
    const value = values[parameter.name]?.trim();
    const material = materials.find(
      (candidate) =>
        candidate.name.localeCompare(value, undefined, {
          sensitivity: "accent",
        }) === 0,
    );
    if (material) selection[parameter.name] = material.id;
  }
  return selection;
}
