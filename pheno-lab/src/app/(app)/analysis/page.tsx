import { requireSession } from "@/lib/auth";
import { getT } from "@/lib/i18n/server";
import { getLang } from "@/lib/i18n/server";
import { Icon } from "@/components/ui";
import {
  GroupBoxPlots,
  type MetricPlot,
} from "@/components/results/GroupBoxPlots";
import { ScopeBar } from "@/components/analysis/ScopeBar";
import { AiReading } from "@/components/analysis/AiReading";
import { ExportTidyCsv } from "@/components/analysis/ExportTidyCsv";
import {
  loadAnalysisDataset,
  listAnalysisProjects,
} from "@/modules/analysis/query";
import {
  compareByCondition,
  detectAnomalies,
  perExperimentOutcomes,
  winCounts,
} from "@/modules/analysis/stats";
import { METRICS, type MetricKey } from "@/lib/analysis-metrics";

// The lab-wide view the reporter builds by hand today: pick what was varied,
// see how its values did across every batch that tried them, and where the
// same conclusion repeats. Deterministic — the AI reading below it works from
// this same computed table, never from raw curves.
export default async function AnalysisPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  const sp = await searchParams;
  const one = (key: string) => {
    const value = sp[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const metricParam = one("metric");
  const metric: MetricKey = (METRICS as readonly string[]).includes(
    metricParam ?? "",
  )
    ? (metricParam as MetricKey)
    : "pce";

  const scope = {
    from: one("from"),
    to: one("to"),
    projectId: one("projectId"),
    q: one("q"),
    condition: one("condition"),
    metric,
  };

  const [t, lang, dataset, projects] = await Promise.all([
    getT(),
    getLang(),
    loadAnalysisDataset(session, scope),
    listAnalysisProjects(session),
  ]);

  const condition = scope.condition
    ? dataset.conditions.find((c) => c.key === scope.condition)
    : undefined;

  const arms = condition
    ? compareByCondition(dataset.rows, condition.key, metric)
    : [];
  const outcomes = condition
    ? perExperimentOutcomes(dataset.rows, condition.key, metric)
    : [];
  const wins = winCounts(outcomes);
  const anomalies = condition
    ? detectAnomalies(
        dataset.rows.filter(
          (row) => row.conditions[condition.key] !== undefined,
        ),
      )
    : [];

  const fmt = (value: number) =>
    Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(2);

  const plots: MetricPlot[] = condition
    ? [
        {
          metric: metric.toUpperCase(),
          groups: arms.map((arm) => ({
            label: arm.value,
            values: arm.samples,
          })),
        },
      ]
    : [];

  return (
    <main className="h-full overflow-y-auto bg-subtle">
      <div className="max-w-5xl mx-auto p-3 sm:p-6 space-y-4">
        <div>
          <h1 className="text-lg font-bold">{t("an.title")}</h1>
          <p className="text-xs text-muted max-w-3xl">{t("an.subtitle")}</p>
        </div>

        <ScopeBar projects={projects} conditions={dataset.conditions} />

        <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-muted">
          <span className="mono">
            {t("an.scopeLine")
              .replace("{experiments}", String(dataset.experiments))
              .replace("{samples}", String(dataset.samplesWithData))}
          </span>
          <ExportTidyCsv scope={scope} disabled={dataset.rows.length === 0} />
        </div>
        {dataset.truncated && (
          <p className="text-[11px] text-warn bg-warn-soft border border-warn-line rounded-[4px] px-2.5 py-1.5">
            {t("an.truncated")}
          </p>
        )}

        {dataset.samplesWithData === 0 ? (
          <p className="bg-surface border border-line rounded-[6px] p-4 text-[12.5px] text-muted">
            {t("an.emptyScope")}
          </p>
        ) : !condition ? (
          <p className="bg-surface border border-line rounded-[6px] p-4 text-[12.5px] text-muted">
            {t("an.emptyCondition")}
          </p>
        ) : (
          <>
            <section className="bg-surface border border-line rounded-[6px] p-3.5">
              <h2 className="text-[12.5px] font-bold flex items-center gap-1.5">
                <Icon name="Rows3" size={14} className="text-charcoal" />
                {t("an.pooled")} · {condition.label}
                {condition.unit ? ` (${condition.unit})` : ""} ·{" "}
                {metric.toUpperCase()}
              </h2>
              <p className="text-[10.5px] text-muted mb-2">
                {t("an.pooledHint")}
              </p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-[12.5px]">
                  <thead>
                    <tr className="text-left text-[10.5px] uppercase text-muted border-b border-line">
                      <th className="px-2 py-1.5 font-bold">{t("an.value")}</th>
                      <th className="px-2 py-1.5 font-bold text-right">
                        {t("an.samples")}
                      </th>
                      <th className="px-2 py-1.5 font-bold text-right">
                        {t("an.experiments")}
                      </th>
                      <th className="px-2 py-1.5 font-bold text-right">
                        {t("an.mean")}
                      </th>
                      <th className="px-2 py-1.5 font-bold text-right">
                        {t("an.median")}
                      </th>
                      <th className="px-2 py-1.5 font-bold text-right">
                        {t("an.best")}
                      </th>
                      <th className="px-2 py-1.5 font-bold text-right">
                        {t("an.sd")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {arms.map((arm) => (
                      <tr
                        key={arm.value}
                        className="border-b border-line last:border-0"
                      >
                        <td className="px-2 py-1.5 font-semibold">
                          {arm.value}
                        </td>
                        <td className="px-2 py-1.5 text-right mono">
                          {arm.summary.n}
                        </td>
                        <td className="px-2 py-1.5 text-right mono">
                          {arm.experiments.length}
                        </td>
                        <td className="px-2 py-1.5 text-right mono font-semibold">
                          {fmt(arm.summary.mean)}
                        </td>
                        <td className="px-2 py-1.5 text-right mono">
                          {fmt(arm.summary.median)}
                        </td>
                        <td className="px-2 py-1.5 text-right mono">
                          {fmt(arm.summary.best)}
                        </td>
                        <td className="px-2 py-1.5 text-right mono text-muted">
                          {fmt(arm.summary.sd)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[10.5px] text-warn mt-2">{t("an.caution")}</p>
            </section>

            <GroupBoxPlots
              plots={plots}
              title={t("an.plots")}
              hint={t("an.plotsHint")}
            />

            {outcomes.length > 0 && (
              <section className="bg-surface border border-line rounded-[6px] p-3.5">
                <h2 className="text-[12.5px] font-bold flex items-center gap-1.5">
                  <Icon name="Layers" size={14} className="text-charcoal" />
                  {t("an.perBatch")}
                </h2>
                <p className="text-[10.5px] text-muted mb-2">
                  {t("an.perBatchHint")}
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px] text-[12.5px]">
                    <thead>
                      <tr className="text-left text-[10.5px] uppercase text-muted border-b border-line">
                        <th className="px-2 py-1.5 font-bold">
                          {t("list.code")}
                        </th>
                        <th className="px-2 py-1.5 font-bold">
                          {t("list.titleCol")}
                        </th>
                        <th className="px-2 py-1.5 font-bold">
                          {t("an.value")}
                        </th>
                        <th className="px-2 py-1.5 font-bold">
                          {t("an.winner")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {outcomes.map((outcome) => (
                        <tr
                          key={outcome.experimentCode}
                          className="border-b border-line last:border-0"
                        >
                          <td className="px-2 py-1.5 mono text-[11.5px] whitespace-nowrap">
                            {outcome.experimentCode}
                          </td>
                          <td className="px-2 py-1.5">
                            <span className="line-clamp-1">
                              {outcome.experimentTitle}
                            </span>
                          </td>
                          <td className="px-2 py-1.5 text-[11.5px]">
                            {outcome.arms
                              .map(
                                (arm) =>
                                  `${arm.value}=${fmt(arm.mean)} (n=${arm.n})`,
                              )
                              .join(" · ")}
                          </td>
                          <td className="px-2 py-1.5 font-semibold text-brand-deep whitespace-nowrap">
                            {outcome.winner}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-[11px] text-charcoal mt-2">
                  <span className="font-bold">{t("an.wins")}:</span>{" "}
                  {wins
                    .map((w) => `${w.value} ${w.wins}/${w.appearances}`)
                    .join(" · ")}
                  <span className="text-muted"> — {t("an.winsHint")}</span>
                </p>
              </section>
            )}

            {anomalies.length > 0 && (
              <section className="bg-surface border border-line rounded-[6px] p-3.5">
                <h2 className="text-[12.5px] font-bold flex items-center gap-1.5 mb-1.5">
                  <Icon name="TriangleAlert" size={14} className="text-warn" />
                  {t("an.anomalies")}
                </h2>
                <ul className="space-y-1 text-[11.5px] text-charcoal">
                  {anomalies.map((flag, i) => (
                    <li key={i} className="flex gap-1.5">
                      <span className="text-muted">·</span>
                      <span>
                        {flag.kind === "champion" &&
                          t("anom.champion")
                            .replace("{sample}", flag.sample)
                            .replace("{group}", flag.group ?? "—")
                            .replace("{value}", fmt(flag.value))}
                        {flag.kind === "negativeResistance" &&
                          t("anom.negative")
                            .replace("{sample}", flag.sample)
                            .replace("{metric}", flag.metric)
                            .replace("{value}", fmt(flag.value))}
                        {flag.kind === "outlier" &&
                          t("anom.outlier")
                            .replace("{sample}", flag.sample)
                            .replace("{group}", flag.group)
                            .replace("{value}", fmt(flag.value))
                            .replace("{median}", fmt(flag.median))}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <AiReading scope={scope} lang={lang} />
          </>
        )}
      </div>
    </main>
  );
}
