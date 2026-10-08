import type { TestPlan } from "./library";

/** Planned groups exist independently of physical substrate allocation. */
export function testPlanGroupLabels(
  plan: Pick<TestPlan, "groups"> | null | undefined,
  samples: { variationGroup: string | null }[],
): string[] {
  if (plan?.groups.length) return plan.groups.map((group) => group.label);
  return [
    ...new Set(
      samples.flatMap((sample) =>
        sample.variationGroup &&
        !["EXTRA", "ERROR"].includes(sample.variationGroup)
          ? [sample.variationGroup]
          : [],
      ),
    ),
  ].sort();
}

/** Missing or obsolete assignments remain in Extras, as in plan application. */
export function substrateCounts(
  groups: { label: string }[],
  count: number,
  assignments: Record<string, string> = {},
) {
  const byGroup = Object.fromEntries(groups.map((group) => [group.label, 0]));
  let extras = 0;
  let errors = 0;
  for (let i = 1; i <= count; i++) {
    const zone = assignments[`S${i}`];
    if (Object.hasOwn(byGroup, zone)) byGroup[zone] += 1;
    else if (zone === "ERROR") errors += 1;
    else extras += 1;
  }
  return {
    total: count,
    grouped: count - extras - errors,
    extras,
    errors,
    byGroup,
  };
}
