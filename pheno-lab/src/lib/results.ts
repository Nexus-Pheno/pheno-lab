const NON_SCIENTIFIC_GROUPS = new Set(["ERROR", "EXTRA"]);

export function resultGroupLabels(
  plannedGroups: { label: string }[] | undefined,
  samples: { variationGroup: string | null }[],
): string[] {
  const source =
    plannedGroups && plannedGroups.length > 0
      ? plannedGroups.map((group) => group.label)
      : samples.flatMap((sample) =>
          sample.variationGroup ? [sample.variationGroup] : [],
        );
  return [...new Set(source)]
    .filter((label) => label && !NON_SCIENTIFIC_GROUPS.has(label))
    .sort();
}

export const isScientificSample = (sample: { variationGroup: string | null }) =>
  sample.variationGroup === null ||
  !NON_SCIENTIFIC_GROUPS.has(sample.variationGroup);
