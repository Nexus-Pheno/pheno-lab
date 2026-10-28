import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { getT, getTerm } from "@/lib/i18n/server";
import type { TestPlan } from "@/lib/library";
import { isScientificSample, resultGroupLabels } from "@/lib/results";
import { Icon } from "@/components/ui";
import { SmartBack } from "@/components/SmartBack";
import {
  GroupBoxPlots,
  type MetricPlot,
} from "@/components/results/GroupBoxPlots";
import { ResultAnalysis } from "@/components/results/ResultAnalysis";
import {
  buildExperimentEvidence,
  selectRepresentativeResults,
  inferenceResultMetrics,
  evidenceNumber,
} from "@/modules/experiments/result-evidence";
import { canManageExperiment } from "@/modules/authorization/policy";
import { AiResultAnalysis } from "@/components/results/AiResultAnalysis";
import { z } from "zod";
import { metricKeyOf } from "@/lib/analysis-metrics";
import { HorizontalScroll } from "@/components/results/HorizontalScroll";
import { getResultsExperiment } from "@/modules/experiments/query";

// Results comparison: measured metrics side by side across variation groups,
// with per-group means, so the effect of each tested variable is readable at
// a glance.
export default async function ResultsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ reference?: string }>;
}) {
  const { id } = await params;
  const session = await requireSession();
  const t = await getT();
  const tt = await getTerm();

  const exp = await getResultsExperiment(session, id);
  if (!exp) notFound();

  const plan = (exp.metadata as { testPlan?: TestPlan } | null)?.testPlan;
  const query = await searchParams;
  const parsedReference = z
    .string()
    .min(1)
    .max(100)
    .optional()
    .safeParse(query.reference);
  const evidence = buildExperimentEvidence(exp, {
    referenceGroup: parsedReference.success ? parsedReference.data : undefined,
  });
  const conditions = evidence.conditions;
  const controlGroup = evidence.reference.selectedGroup ?? undefined;
  const groups = [
    ...new Set([
      ...resultGroupLabels(
        Array.isArray(plan?.groups) ? plan.groups : undefined,
        exp.samples,
      ),
      ...evidence.characterizations.flatMap((item) =>
        item.groups.map((group) => group.label),
      ),
    ]),
  ];
  const scientificSampleIds = new Set(
    exp.samples.filter(isScientificSample).map((sample) => sample.id),
  );

  // Tested variables with per-group values, from the steps' variations.
  const variables = exp.steps.flatMap((st) =>
    st.parameters
      .filter((p) => p.variations.length > 0)
      .map((p) => ({
        id: p.id,
        name: p.name,
        unit: p.unit,
        process: st.name || st.process.name,
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
    <main className="h-full overflow-y-auto overflow-x-hidden bg-subtle">
      <div className="w-full min-w-0 p-4 sm:p-6 space-y-5">
        <div className="flex flex-wrap items-center gap-2.5">
          <Icon name="BarChart3" size={17} className="text-brand-deep" />
          <div className="flex-1 min-w-0">
            <h1 className="text-[16px] font-bold">
              <span className="mono">{exp.code}</span> · {t("res.compare")}
            </h1>
            <p className="text-[11.5px] text-muted">{t("res.subtitle")}</p>
          </div>
          <SmartBack fallback={`/experiments/${exp.id}`} />
        </div>
        <p className="text-[12px] font-semibold">{exp.title}</p>
        <p className="text-[11px] text-muted">{t("res.evidence.policy")}</p>
        <form
          method="get"
          className="flex flex-wrap items-center gap-2 text-[12px]"
        >
          <label htmlFor="analysis-reference">
            {t("res.evidence.reference")}
          </label>
          <select
            id="analysis-reference"
            name="reference"
            defaultValue={controlGroup ?? ""}
            className="min-h-10 border border-line rounded px-3 bg-surface"
          >
            {!controlGroup && <option value="">—</option>}
            {groups.map((group) => (
              <option key={group} value={group}>
                {group}
              </option>
            ))}
          </select>
          <button className="min-h-10 px-3 border border-line rounded bg-surface font-semibold">
            {t("res.evidence.apply")}
          </button>
          {evidence.reference.declaredGroup && (
            <span className="text-muted">
              {t("res.evidence.planReference", {
                group: evidence.reference.declaredGroup,
              })}
            </span>
          )}
          {evidence.reference.basis === "EXPLICIT_UNTREATED_REFERENCE" &&
            controlGroup && (
              <span className="text-brand-deep">
                {t("res.evidence.untreated", { group: controlGroup })}
              </span>
            )}
        </form>
        {evidence.reference.warning && (
          <p data-reference-warning className="text-[12px] text-warn">
            {t(
              evidence.reference.warning === "MULTIPLE_UNTREATED_REFERENCES"
                ? "res.evidence.multipleReferences"
                : "res.evidence.referenceWarning",
            )}
          </p>
        )}
        <p className="text-[11px] text-muted">{t("res.scrollHint")}</p>
        {evidence.evaluationFocus.requiresNonJvEvidence && (
          <p className="text-[12px] text-warn">{t("res.evidence.nonJv")}</p>
        )}
        <AiResultAnalysis
          key={`${exp.id}:${controlGroup ?? "default"}`}
          experimentId={exp.id}
          canAnalyze={canManageExperiment(session, exp)}
          referenceGroup={controlGroup}
        />

        {/* Keep the plan visible before any measurements have been captured. */}
        {!hasAnyResult && variables.length > 0 && groups.length > 0 && (
          <section className="bg-surface border border-line rounded-[6px] p-3.5 min-w-0">
            <h2 className="text-[11px] font-bold uppercase text-muted mb-2">
              {t("res.variables")}
            </h2>
            <HorizontalScroll label={t("res.variables")}>
              <table className="text-[12.5px] min-w-full">
                <thead>
                  <tr className="text-left text-[10px] uppercase text-muted">
                    <th className="pr-4 pb-1 font-bold">{t("res.group")}</th>
                    {variables.map((v) => (
                      <th key={v.id} className="pr-4 pb-1 font-bold">
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
                        data-empty-group={
                          sampleCount === 0 ? "true" : undefined
                        }
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
                        {variables.map((v) => (
                          <td key={v.id} className="pr-4 py-1.5 mono">
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
            </HorizontalScroll>
          </section>
        )}

        {!hasAnyResult && (
          <p className="text-center text-muted text-sm py-8">
            {t("res.noResults")}
          </p>
        )}

        {/* Per-characterization comparison */}
        {exp.characterizations.map((characterization) => {
          const c = {
            ...characterization,
            results: selectRepresentativeResults(
              characterization.results,
              exp.samples,
            ),
          };
          const characterizationEvidence = evidence.characterizations.find(
            (item) => item.id === c.id,
          );
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

          const numericFor = (
            sampleId: string,
            metric: string,
          ): number | null => {
            const key = metricKeyOf(metric);
            return key
              ? (inferenceResultMetrics(resultFor(sampleId))[key] ?? null)
              : evidenceNumber(resultFor(sampleId)[metric]);
          };

          // Box-plot data: per metric, each group's numeric values with the
          // sample they came from.
          const plots: MetricPlot[] = metricNames.map((m) => ({
            metric: m,
            groups: groups.map((g) => ({
              label: g,
              values: exp.samples
                .filter(
                  (s) =>
                    s.variationGroup === g && scientificSampleIds.has(s.id),
                )
                .map((s) => ({
                  value: numericFor(s.id, m),
                  code: s.code,
                }))
                .filter(
                  (v): v is { value: number; code: string } =>
                    v.value !== null && Number.isFinite(v.value),
                ),
            })),
          }));

          return (
            <div key={c.id} className="space-y-5">
              <section
                className="bg-surface border border-line rounded-[6px] p-3.5 min-w-0"
                data-result-comparison={c.id}
              >
                <h2 className="text-[12.5px] font-bold flex items-center gap-1.5 mb-2">
                  <Icon
                    name={c.process.icon}
                    size={14}
                    className="text-charcoal"
                  />
                  {tt(c.name)}
                </h2>
                <HorizontalScroll
                  label={`${tt(c.name)} · ${t("res.variables")}`}
                >
                  <table className="text-[12.5px] min-w-full">
                    <thead>
                      <tr className="text-left text-[10px] uppercase text-muted">
                        <th className="sticky left-0 z-10 bg-surface min-w-24 pr-4 pb-1 font-bold border-r border-line">
                          {t("res.sampleId")}
                        </th>
                        <th className="min-w-20 whitespace-nowrap pr-4 pb-1 font-bold">
                          {t("res.group")}
                        </th>
                        {variables.map((variable) => (
                          <th
                            key={variable.id}
                            className="min-w-40 max-w-64 pr-4 pb-1 font-bold"
                            data-result-variable={variable.id}
                          >
                            <span className="block font-normal normal-case text-muted">
                              {tt(variable.process)}
                            </span>
                            {tt(variable.name)}
                            {variable.unit ? ` (${variable.unit})` : ""}
                          </th>
                        ))}
                        {metricNames.map((m) => (
                          <th
                            key={m}
                            className="pr-4 pb-1 font-bold text-right"
                          >
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
                              <td className="sticky left-0 bg-surface pr-4 py-1.5 mono border-r border-line">
                                —
                              </td>
                              <td className="min-w-20 whitespace-nowrap pr-4 py-1.5 mono">
                                {g}
                              </td>
                              {variables.map((variable) => (
                                <td
                                  key={variable.id}
                                  className="pr-4 py-1.5 mono"
                                >
                                  —
                                </td>
                              ))}
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
                            <tr
                              key={s.id}
                              className="border-t border-line"
                              data-result-sample={s.code}
                            >
                              <td className="sticky left-0 bg-surface min-w-24 pr-4 py-1.5 mono border-r border-line">
                                <span className="block font-bold">
                                  {s.code}
                                </span>
                                {s.simCode && (
                                  <span className="block text-[10px] text-muted">
                                    {s.simCode}
                                  </span>
                                )}
                              </td>
                              <td className="min-w-20 whitespace-nowrap pr-4 py-1.5 mono">
                                {s.variationGroup ?? "—"}
                                {s.variationGroup === controlGroup && (
                                  <span className="text-[10px] text-muted">
                                    {" "}
                                    ({t("plan.controlWord")})
                                  </span>
                                )}
                              </td>
                              {variables.map((variable) => (
                                <td
                                  key={variable.id}
                                  className="min-w-40 max-w-64 break-words pr-4 py-1.5 mono"
                                  data-result-variable={variable.id}
                                >
                                  {s.variationGroup
                                    ? (variable.values[s.variationGroup] ?? "—")
                                    : "—"}
                                </td>
                              ))}
                              {metricNames.map((m) => (
                                <td
                                  key={m}
                                  className="pr-4 py-1.5 mono text-right"
                                >
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
                                colSpan={variables.length + 2}
                              >
                                <span className="sticky left-0 inline-block">
                                  {g} {t("res.mean")}
                                </span>
                              </td>
                              {metricNames.map((m) => {
                                const nums = withData
                                  .map((sample) => numericFor(sample.id, m))
                                  .filter(
                                    (value): value is number => value !== null,
                                  );
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
                </HorizontalScroll>
              </section>
              <GroupBoxPlots
                plots={plots}
                title={`${tt(c.name)} · ${t("res.dist")}`}
                hint={t("res.distHint")}
              />
              <ResultAnalysis
                plots={plots}
                evidence={characterizationEvidence}
                conditions={conditions}
                controlGroup={controlGroup}
                t={t}
                tt={tt}
              />
            </div>
          );
        })}
      </div>
    </main>
  );
}
