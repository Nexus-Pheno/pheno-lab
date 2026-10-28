import type { ExperimentEvidence } from "@/modules/experiments/result-evidence";
import { metricKeyOf } from "@/lib/analysis-metrics";
import type { TKey } from "@/lib/i18n/dict";
import { analyzeResultPlots } from "@/modules/experiments/results-analysis";
import type { MetricPlot } from "./GroupBoxPlots";

const number = (value: number) => Number(value.toPrecision(4)).toString();
const difference = (value: number) => `${value > 0 ? "+" : ""}${number(value)}`;

export function ResultAnalysis({
  plots,
  evidence,
  conditions,
  controlGroup,
  t,
  tt,
}: {
  plots: MetricPlot[];
  evidence?: ExperimentEvidence["characterizations"][number];
  conditions: ExperimentEvidence["conditions"];
  controlGroup: string | undefined;
  t: (key: TKey, vars?: Record<string, string>) => string;
  tt: (value: string) => string;
}) {
  const analysis = analyzeResultPlots(plots, controlGroup);
  if (!analysis.length) return null;
  const groups = analysis[0].groups.map((group) => group.label);
  const actualConditions = conditions.filter(
    (condition) => !condition.plannedOnly,
  );
  const changing = actualConditions.filter(
    (condition) =>
      new Set(groups.map((group) => condition.values[group]).filter(Boolean))
        .size > 1,
  );

  return (
    <section
      className="bg-surface border border-line rounded-[6px] p-3.5 sm:p-5 min-w-0 space-y-4"
      data-result-analysis
    >
      <div>
        <h2 className="text-[14px] font-bold">{t("res.analysis.title")}</h2>
        <p className="text-[11.5px] text-muted mt-1">
          {t("res.evidence.policy")}
        </p>
      </div>

      <p className="text-[11px] text-muted">{t("res.evidence.rule")}</p>
      {evidence?.comparabilityWarnings.some(
        (warning) => warning !== "INDEPENDENT_BATCHES_NOT_VERIFIED",
      ) && (
        <p className="text-[11px] text-warn">{t("res.evidence.protocol")}</p>
      )}
      {evidence && evidence.nInvalidMetricVectors > 0 && (
        <p className="text-[11px] text-warn">
          {t("res.evidence.invalid", {
            n: String(evidence.nInvalidMetricVectors),
          })}
        </p>
      )}
      <div className="grid sm:grid-cols-2 gap-3">
        {analysis.map((metric) => (
          <div
            key={metric.metric}
            className="rounded border border-line p-3 min-w-0"
          >
            <h3 className="font-bold text-[12px]">{metric.metric}</h3>
            <p className="text-[12px] mt-1">
              {metric.highest.length
                ? t("res.analysis.highest", {
                    groups: metric.highest
                      .map((group) => group.label)
                      .join(", "),
                    value: number(metric.highest[0].summary!.mean),
                  })
                : t("res.analysis.noData")}
            </p>
            <p className="text-[11px] text-muted mt-1">
              {t("res.analysis.range", {
                values: metric.groups
                  .filter((group) => group.summary)
                  .map(
                    (group) => `${group.label}: ${number(group.summary!.mean)}`,
                  )
                  .join(" · "),
              })}
            </p>
            {!metric.groups.some(
              (group) => group.label === controlGroup && group.summary,
            ) && (
              <p className="text-[11px] text-muted mt-1">
                {t("res.analysis.noControl")}
              </p>
            )}
          </div>
        ))}
      </div>

      <details
        className="border border-line rounded p-3"
        open={conditions.length <= 4}
      >
        <summary className="text-[12px] font-semibold cursor-pointer">
          {t("res.analysis.conditions")}
        </summary>
        <div className="grid sm:grid-cols-2 gap-3 mt-3 text-[12px]">
          {conditions.map((condition) => (
            <div key={condition.id} className="min-w-0 break-words">
              <h3 className="font-semibold">
                {tt(condition.name)}
                {condition.unit ? ` (${condition.unit})` : ""}
              </h3>
              <p className="text-muted text-[11px]">
                {[condition.layer, condition.process, condition.equipment]
                  .filter(Boolean)
                  .map(tt)
                  .join(" · ") || t("res.analysis.unlinked")}
              </p>
              {condition.materials.length > 0 && (
                <p className="text-[11px] text-muted">
                  {t("res.analysis.materials")}:{" "}
                  {condition.materials.join(" · ")}
                </p>
              )}
              {condition.materialVariables.length > 0 && (
                <p className="text-[11px] text-muted">
                  {t("res.analysis.materialVariables")}:{" "}
                  {condition.materialVariables.map(tt).join(" · ")}
                </p>
              )}
              <p className="text-[11px] mt-1">
                {condition.plannedOnly
                  ? t("res.analysis.planOnly")
                  : t("res.analysis.flowSource")}
              </p>
              {condition.plannedValues &&
                groups.some(
                  (group) =>
                    condition.plannedValues![group] !== undefined &&
                    condition.plannedValues![group] !== condition.values[group],
                ) && (
                  <p className="text-warn text-[11px] mt-1" data-plan-mismatch>
                    {t("res.analysis.mismatch", {
                      values: groups
                        .filter(
                          (group) =>
                            condition.plannedValues![group] !== undefined &&
                            condition.plannedValues![group] !==
                              condition.values[group],
                        )
                        .map(
                          (group) =>
                            `${group}: ${condition.plannedValues![group]} → ${condition.values[group] ?? "—"}`,
                        )
                        .join(" · "),
                    })}
                  </p>
                )}
            </div>
          ))}
          {!conditions.length && <p>{t("res.analysis.noConditions")}</p>}
        </div>
      </details>

      <div className="grid lg:grid-cols-2 gap-3">
        {groups.map((group) => {
          const changes = actualConditions.filter(
            (condition) =>
              controlGroup &&
              condition.values[group]?.trim() &&
              condition.values[controlGroup]?.trim() &&
              condition.values[group] !== condition.values[controlGroup],
          );
          return (
            <article
              key={group}
              className="border border-line rounded p-3 min-w-0 text-[12px]"
              data-analysis-group={group}
            >
              <h3 className="font-bold mono">
                {group}
                {group === controlGroup
                  ? ` · ${t("res.evidence.reference")}`
                  : ""}
              </h3>
              <p className="mt-1 text-[11.5px] break-words">
                {conditions
                  .filter((item) =>
                    /material|材料|sam|浓度|溶剂|工艺/i.test(item.name),
                  )
                  .map(
                    (item) =>
                      `${tt(item.name)}: ${item.values[group] || "—"}${item.unit ? ` ${item.unit}` : ""}`,
                  )
                  .join(" · ")}
              </p>
              {evidence?.groups.find((item) => item.label === group) &&
                (() => {
                  const item = evidence.groups.find(
                    (item) => item.label === group,
                  )!;
                  return (
                    <div
                      data-screening-judgment={item.judgment}
                      className="mt-2 border-l-2 border-brand pl-2 space-y-1 text-[12px]"
                    >
                      <p>
                        <strong>{t("res.evidence.value")}: </strong>
                        {t(`res.evidence.${item.judgment}` as TKey)}
                      </p>
                      <p className="text-[11px] text-muted">
                        <strong>{t("res.evidence.confidence")}: </strong>
                        {t(`res.evidence.${item.evidenceConfidence}` as TKey)}
                      </p>
                      {item.deltaBest.pce !== undefined &&
                        group !== controlGroup && (
                          <p>
                            {t("res.evidence.bestDelta", {
                              group: controlGroup ?? "—",
                              value: difference(item.deltaBest.pce),
                            })}
                          </p>
                        )}
                    </div>
                  );
                })()}
              <details className="mt-2" open={conditions.length <= 3}>
                <summary className="text-[11px] font-semibold cursor-pointer">
                  {t("res.analysis.groupConditions")}
                </summary>
                <ul className="mt-2 space-y-1 text-[11px] break-words">
                  {conditions.map((condition) => (
                    <li key={condition.id}>
                      {[condition.layer, condition.process, tt(condition.name)]
                        .filter(Boolean)
                        .join(" · ")}
                      : {condition.values[group] || "—"}
                      {condition.unit ? ` ${condition.unit}` : ""}
                      {condition.plannedOnly
                        ? ` (${t("res.analysis.design")})`
                        : ""}
                      {condition.actualByGroup[group] && (
                        <span className="block text-muted">
                          {t("res.evidence.recorded")}:{" "}
                          {condition.actualByGroup[group].values.join(" / ") ||
                            "—"}{" "}
                          (
                          {t(
                            `res.evidence.${condition.actualByGroup[group].status}` as TKey,
                          )}
                          ; {condition.actualByGroup[group].nRecordedSamples}/
                          {condition.actualByGroup[group].nPlannedSamples})
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </details>
              {group !== controlGroup && controlGroup && changes.length > 0 && (
                <p className="mt-2 text-[11px] text-muted">
                  {t("res.analysis.changed", {
                    group: controlGroup,
                    variables: changes
                      .slice(0, 3)
                      .map((condition) =>
                        [condition.layer, condition.process, tt(condition.name)]
                          .filter(Boolean)
                          .join(" · "),
                      )
                      .join("; "),
                  })}
                  {changes.length > 3 &&
                    ` ${t("res.analysis.moreConditions", { n: String(changes.length) })}`}
                </p>
              )}
              <dl className="mt-3 space-y-1.5 border-t border-line pt-2">
                {analysis.map((metric) => {
                  const outcome = metric.groups.find(
                    (item) => item.label === group,
                  )!;
                  return (
                    <div key={metric.metric}>
                      <dt className="font-semibold">{metric.metric}</dt>
                      <dd className="text-[11px] text-muted">
                        {outcome.summary
                          ? t("res.analysis.stats", {
                              n: String(outcome.summary.n),
                              mean: number(outcome.summary.mean),
                              median: number(outcome.summary.median),
                              min: number(outcome.summary.worst),
                              max: number(outcome.summary.best),
                            })
                          : t("res.analysis.noData")}
                        {group !== controlGroup && outcome.delta !== null && (
                          <span className="block text-charcoal">
                            {t("res.analysis.delta", {
                              group: controlGroup!,
                              value: difference(outcome.delta),
                            })}
                          </span>
                        )}
                        {(() => {
                          const key = metricKeyOf(metric.metric);
                          const stats = key
                            ? evidence?.groups.find(
                                (item) => item.label === group,
                              )?.metrics[key]
                            : null;
                          return stats ? (
                            <span className="block">
                              {t("res.evidence.spread", {
                                sd: stats.sd === null ? "—" : number(stats.sd),
                                iqr: number(stats.iqr),
                              })}
                            </span>
                          ) : null;
                        })()}
                        {outcome.summary?.n === 1 && (
                          <span className="block">
                            {t("res.analysis.single")}
                          </span>
                        )}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </article>
          );
        })}
      </div>
      <p className="text-[11px] text-muted">
        {changing.length > 1
          ? t("res.analysis.combined")
          : t("res.analysis.descriptive")}{" "}
        {t("res.analysis.units")}
        {!controlGroup ||
        !analysis.some((metric) =>
          metric.groups.some(
            (group) => group.label === controlGroup && group.summary,
          ),
        )
          ? ` ${t("res.analysis.noControl")}`
          : ""}
      </p>
    </section>
  );
}
