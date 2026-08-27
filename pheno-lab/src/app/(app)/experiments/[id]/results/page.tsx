import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { getT, getTerm } from "@/lib/i18n/server";
import type { TestPlan } from "@/lib/library";
import { isScientificSample, resultGroupLabels } from "@/lib/results";
import { Icon } from "@/components/ui";
import { SmartBack } from "@/components/SmartBack";
import { getResultsExperiment } from "@/modules/experiments/query";

// Results comparison: measured metrics side by side across variation groups,
// with per-group means, so the effect of each tested variable is readable at
// a glance.
export default async function ResultsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireSession();
  const t = await getT();
  const tt = await getTerm();

  const exp = await getResultsExperiment(session, id);
  if (!exp) notFound();

  const plan = (exp.metadata as { testPlan?: TestPlan } | null)?.testPlan;
  const groups = resultGroupLabels(plan?.groups, exp.samples);
  const controlGroup = plan?.groups.find((g) => g.isControl)?.label;
  const scientificSampleIds = new Set(
    exp.samples.filter(isScientificSample).map((sample) => sample.id),
  );

  // Tested variables with per-group values, from the steps' variations.
  const variables = exp.steps.flatMap((st) =>
    st.parameters
      .filter((p) => p.variations.length > 0)
      .map((p) => ({
        name: p.name,
        unit: p.unit,
        process: st.process.name,
        values: Object.fromEntries(
          p.variations.map((v) => [v.variationGroup, v.value]),
        ),
      })),
  );

  const hasAnyResult = exp.characterizations.some((c) =>
    c.results.some(
      (r) =>
        r.sampleId !== null &&
        scientificSampleIds.has(r.sampleId) &&
        Object.values((r.metrics ?? {}) as Record<string, string>).some(
          (v) => v !== "",
        ),
    ),
  );

  const mean = (vals: number[]) =>
    vals.length
      ? (vals.reduce((a, b) => a + b, 0) / vals.length)
          .toPrecision(4)
          .replace(/\.?0+$/, "")
      : "";

  return (
    <main className="h-full overflow-y-auto bg-subtle">
      <div className="max-w-4xl mx-auto p-4 sm:p-6 space-y-5">
        <div className="flex items-center gap-2.5">
          <Icon name="BarChart3" size={17} className="text-brand-deep" />
          <div className="flex-1 min-w-0">
            <h1 className="text-[16px] font-bold">
              <span className="mono">{exp.code}</span> · {t("res.compare")}
            </h1>
            <p className="text-[11.5px] text-muted">{t("res.subtitle")}</p>
          </div>
          <Link
            href={`/experiments/${exp.id}/report`}
            className="h-8 flex items-center px-2.5 text-[12px] font-semibold text-charcoal border border-line rounded-[4px] hover:bg-subtle"
          >
            {t("rep.title")}
          </Link>
          <SmartBack fallback={`/experiments/${exp.id}`} />
        </div>

        {/* Tested variables per group */}
        {variables.length > 0 && groups.length > 0 && (
          <section className="bg-surface border border-line rounded-[6px] p-3.5 overflow-x-auto">
            <h2 className="text-[11px] font-bold uppercase text-muted mb-2">
              {t("res.variables")}
            </h2>
            <table className="text-[12.5px] min-w-full">
              <thead>
                <tr className="text-left text-[10px] uppercase text-muted">
                  <th className="pr-4 pb-1 font-bold">{t("res.group")}</th>
                  {variables.map((v, i) => (
                    <th key={i} className="pr-4 pb-1 font-bold">
                      {tt(v.name)}
                      {v.unit ? ` (${v.unit})` : ""}{" "}
                      <span className="font-normal normal-case">
                        · {tt(v.process)}
                      </span>
                    </th>
                  ))}
                  <th className="pb-1 font-bold text-right">
                    {t("res.samples")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const sampleCount = exp.samples.filter(
                    (sample) => sample.variationGroup === g,
                  ).length;
                  return (
                    <tr
                      key={g}
                      className="border-t border-line"
                      data-result-group={g}
                      data-empty-group={sampleCount === 0 ? "true" : undefined}
                    >
                      <td className="pr-4 py-1.5">
                        <span
                          className={
                            "mono font-bold " +
                            (g === controlGroup ? "" : "text-brand-deep")
                          }
                        >
                          {g}
                        </span>
                        {g === controlGroup && (
                          <span className="text-[10px] text-muted">
                            {" "}
                            ({t("plan.controlWord")})
                          </span>
                        )}
                      </td>
                      {variables.map((v, i) => (
                        <td key={i} className="pr-4 py-1.5 mono">
                          {sampleCount > 0 ? (v.values[g] ?? "—") : "—"}
                        </td>
                      ))}
                      <td className="py-1.5 mono text-right">
                        {sampleCount > 0 ? sampleCount : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        )}

        {!hasAnyResult && (
          <p className="text-center text-muted text-sm py-8">
            {t("res.noResults")}
          </p>
        )}

        {/* Per-characterization comparison */}
        {exp.characterizations.map((c) => {
          const metricNames = [
            ...new Set(
              c.results
                .filter(
                  (result) =>
                    result.sampleId !== null &&
                    scientificSampleIds.has(result.sampleId),
                )
                .flatMap((r) =>
                  Object.entries((r.metrics ?? {}) as Record<string, string>)
                    .filter(([, v]) => v !== "")
                    .map(([k]) => k),
                ),
            ),
          ];
          if (metricNames.length === 0) return null;
          const resultFor = (sampleId: string) =>
            (c.results.find((r) => r.sampleId === sampleId)?.metrics ??
              {}) as Record<string, string>;

          return (
            <section
              key={c.id}
              className="bg-surface border border-line rounded-[6px] p-3.5 overflow-x-auto"
            >
              <h2 className="text-[12.5px] font-bold flex items-center gap-1.5 mb-2">
                <Icon
                  name={c.process.icon}
                  size={14}
                  className="text-charcoal"
                />
                {tt(c.name)}
              </h2>
              <table className="text-[12.5px] min-w-full">
                <thead>
                  <tr className="text-left text-[10px] uppercase text-muted">
                    <th className="pr-4 pb-1 font-bold">{t("cap.sample")}</th>
                    <th className="pr-4 pb-1 font-bold">{t("res.group")}</th>
                    {metricNames.map((m) => (
                      <th key={m} className="pr-4 pb-1 font-bold text-right">
                        {m}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(groups.length > 0 ? groups : [null]).map((g) => {
                    const samples = exp.samples.filter((s) =>
                      g === null
                        ? isScientificSample(s)
                        : s.variationGroup === g,
                    );
                    if (g !== null && samples.length === 0) {
                      return (
                        <tr
                          key={`${g}-empty`}
                          className="border-t border-line"
                          data-result-group={g}
                          data-empty-group="true"
                        >
                          <td className="pr-4 py-1.5 mono">—</td>
                          <td className="pr-4 py-1.5 mono">{g}</td>
                          {metricNames.map((metric) => (
                            <td
                              key={metric}
                              className="pr-4 py-1.5 mono text-right"
                            >
                              —
                            </td>
                          ))}
                        </tr>
                      );
                    }
                    const withData = samples.filter((s) =>
                      metricNames.some(
                        (m) => (resultFor(s.id)[m] ?? "") !== "",
                      ),
                    );
                    if (withData.length === 0) return null;
                    return [
                      ...withData.map((s) => (
                        <tr key={s.id} className="border-t border-line">
                          <td className="pr-4 py-1.5 mono">{s.code}</td>
                          <td className="pr-4 py-1.5 mono">
                            {s.variationGroup ?? "—"}
                            {s.variationGroup === controlGroup && (
                              <span className="text-[10px] text-muted">
                                {" "}
                                ({t("plan.controlWord")})
                              </span>
                            )}
                          </td>
                          {metricNames.map((m) => (
                            <td key={m} className="pr-4 py-1.5 mono text-right">
                              {resultFor(s.id)[m] ?? ""}
                            </td>
                          ))}
                        </tr>
                      )),
                      g !== null && withData.length > 1 ? (
                        <tr
                          key={g + "-mean"}
                          className="border-t border-line bg-brand-soft/40"
                        >
                          <td
                            className="pr-4 py-1.5 text-[11px] font-bold text-brand-deep"
                            colSpan={2}
                          >
                            {g} {t("res.mean")}
                          </td>
                          {metricNames.map((m) => {
                            const nums = withData
                              .map((s) => parseFloat(resultFor(s.id)[m] ?? ""))
                              .filter((n) => !isNaN(n));
                            return (
                              <td
                                key={m}
                                className="pr-4 py-1.5 mono text-right font-bold text-brand-deep"
                              >
                                {mean(nums)}
                              </td>
                            );
                          })}
                        </tr>
                      ) : null,
                    ];
                  })}
                </tbody>
              </table>
            </section>
          );
        })}
      </div>
    </main>
  );
}
