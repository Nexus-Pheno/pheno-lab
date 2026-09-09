import Image from "next/image";
import { notFound } from "next/navigation";
import { getSession, requireSession } from "@/lib/auth";
import { getT } from "@/lib/i18n/server";
import type { TestPlan } from "@/lib/library";
import { Icon } from "@/components/ui";
import { PrintButton } from "@/components/report/PrintButton";
import { fmtBeijing } from "@/lib/datetime";
import { resultGroupLabels } from "@/lib/results";
import type { MetricKey } from "@/lib/analysis-metrics";
import { metricKeyOf, numish } from "@/modules/experiments/summary-service";
import { variedConditions } from "@/modules/analysis/dataset";
import { detectAnomalies } from "@/modules/analysis/stats";
import {
  getExperimentCode,
  getReportExperiment,
} from "@/modules/experiments/query";

// Browsers name printed PDFs after the document title — use the experiment code.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const actor = await getSession();
  const exp = actor ? await getExperimentCode(actor, id) : null;
  return { title: exp?.code ?? "Report" };
}

// The experiment report: everything about a completed experiment in one
// beautiful, print-ready document — narrative, plan, flow, and results.
export default async function ReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireSession();
  const t = await getT();

  const exp = await getReportExperiment(session, id);
  if (!exp) notFound();

  const plan = (exp.metadata as { testPlan?: TestPlan } | null)?.testPlan;
  const groups = [
    ...new Set(exp.samples.map((s) => s.variationGroup).filter(Boolean)),
  ].sort() as string[];
  const controlGroup = plan?.groups.find((g) => g.isControl)?.label;

  // What this experiment actually varied. Reading the steps as well as the
  // plan is what keeps this table from coming out empty when the key variable
  // was set on a step and never entered in the plan grid (使用反馈报告-2, 图11).
  const conditions = variedConditions(exp);
  const reportGroups = resultGroupLabels(plan?.groups, exp.samples);
  const sampleCountByGroup = new Map<string, number>();
  for (const sample of exp.samples) {
    if (!sample.variationGroup) continue;
    sampleCountByGroup.set(
      sample.variationGroup,
      (sampleCountByGroup.get(sample.variationGroup) ?? 0) + 1,
    );
  }

  // Deterministic flags a reader would otherwise have to spot by eye.
  const groupOf = new Map(exp.samples.map((s) => [s.id, s.variationGroup]));
  const codeOf = new Map(exp.samples.map((s) => [s.id, s.code]));
  const metricsBySample = new Map<string, Partial<Record<MetricKey, number>>>();
  for (const char of exp.characterizations) {
    for (const result of char.results) {
      // Experiment-level rows carry no sample; they cannot be flagged per device.
      if (!result.sampleId) continue;
      const metrics = metricsBySample.get(result.sampleId) ?? {};
      for (const [label, value] of Object.entries(
        (result.metrics ?? {}) as Record<string, unknown>,
      )) {
        const key = metricKeyOf(label);
        if (!key || metrics[key] !== undefined) continue;
        const parsed = numish(value);
        if (parsed !== null) metrics[key] = parsed;
      }
      metricsBySample.set(result.sampleId, metrics);
    }
  }
  const anomalies = detectAnomalies(
    [...metricsBySample.entries()].map(([sampleId, metrics]) => ({
      sampleCode: codeOf.get(sampleId) ?? sampleId,
      group: groupOf.get(sampleId) ?? null,
      metrics,
    })),
    exp.jvMeasurements,
  );

  const sciBlocks = [
    { label: t("sci.observation"), text: exp.observation },
    { label: t("sci.problem"), text: exp.problem },
    { label: t("sci.hypothesis"), text: exp.hypothesis },
    { label: t("sci.conclusion"), text: exp.conclusion },
  ].filter((b) => b.text);

  // Deviations: executions whose actuals differ from plan, plus notes/flags.
  const deviations: {
    step: string;
    sample: string;
    text: string;
    flagged: boolean;
  }[] = [];
  for (const run of exp.runs) {
    for (const x of run.executions) {
      const step = exp.steps.find((s) => s.id === x.stepId);
      const sample = exp.samples.find((s) => s.id === x.sampleId);
      if (!step || !sample) continue;
      const actuals = (x.actuals ?? {}) as Record<string, string>;
      const diffs: string[] = [];
      for (const p of step.parameters) {
        const planned = sample.variationGroup
          ? (p.variations.find(
              (v) => v.variationGroup === sample.variationGroup,
            )?.value ?? p.value)
          : p.value;
        const actual = actuals[p.name];
        if (actual !== undefined && actual !== planned)
          diffs.push(`${p.name}: ${planned} → ${actual} ${p.unit}`.trim());
      }
      if (diffs.length || x.note || x.flagged) {
        deviations.push({
          step:
            `${String(step.position + 1).padStart(2, "0")} ${step.name}` +
            (exp.runs.length > 1 ? ` · ${t("res.run")} ${run.runNo}` : ""),
          sample: sample.code,
          text: [diffs.join("; "), x.note].filter(Boolean).join(" — "),
          flagged: x.flagged,
        });
      }
    }
  }

  const mean = (vals: number[]) =>
    vals.length
      ? (vals.reduce((a, b) => a + b, 0) / vals.length)
          .toPrecision(4)
          .replace(/\.?0+$/, "")
      : "";

  const h2 =
    "text-[11px] font-bold uppercase tracking-wide text-brand-deep border-b-2 border-brand pb-1 mb-3";

  return (
    <main className="h-full overflow-y-auto bg-subtle print:bg-white">
      <div className="max-w-3xl mx-auto p-4 sm:p-8">
        {/* Screen-only toolbar */}
        <div className="flex justify-end mb-3 print:hidden">
          <PrintButton title={exp.code} />
        </div>

        <article className="bg-white border border-line rounded-[8px] print:border-0 px-8 py-10 sm:px-12 space-y-8">
          {/* Title block */}
          <header className="border-b border-line pb-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="mono text-[13px] font-bold text-brand-deep mb-1">
                  {exp.code}
                </div>
                <h1 className="text-[22px] font-bold leading-tight">
                  {exp.title}
                </h1>
                {exp.campaign && (
                  <div className="text-[12px] text-muted mt-1">
                    {t("set.campaign")}: {exp.campaign}
                  </div>
                )}
              </div>
              <Image
                src="/brand/pheno-logo.png"
                alt="Pheno"
                width={84}
                height={24}
                className="mt-1"
              />
            </div>
            <div className="flex flex-wrap gap-x-8 gap-y-1 mt-4 text-[11.5px]">
              <span>
                <span className="text-muted">{t("rep.completed")}:</span>{" "}
                {t(`status.${exp.status}` as "status.DRAFT")}
              </span>
              <span>
                <span className="text-muted">{t("rep.created")}:</span>{" "}
                <span className="mono">
                  {fmtBeijing(exp.createdAt, "date")}
                </span>
              </span>
              <span>
                <span className="text-muted">{t("rep.team")}:</span>{" "}
                {[
                  exp.createdBy.name,
                  ...exp.members
                    .map((m) => m.user.name)
                    .filter((n) => n !== exp.createdBy.name),
                ].join(", ")}
              </span>
              <span>
                <span className="text-muted">{t("res.samples")}:</span>{" "}
                <span className="mono">{exp.samples.length}</span>
              </span>
            </div>
            {exp.labels.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-3">
                {exp.labels.map((l) => (
                  <span
                    key={l.labelId}
                    className="text-[9.5px] px-1.5 py-0.5 bg-subtle border border-line rounded-[3px] text-charcoal"
                  >
                    {l.label.name}
                  </span>
                ))}
              </div>
            )}
          </header>

          {/* Sign-off / evidence pack */}
          {exp.approvedAt && (
            <section className="bg-subtle border border-line rounded-[6px] p-4 print:bg-white">
              <h2 className={h2}>{t("wf.evidence")}</h2>
              <div className="flex flex-wrap gap-x-8 gap-y-1 text-[11.5px]">
                {exp.assignee && (
                  <span>
                    <span className="text-muted">{t("wf.assignee")}:</span>{" "}
                    {exp.assignee.name}
                  </span>
                )}
                {exp.submittedAt && (
                  <span>
                    <span className="text-muted">{t("wf.submittedBy")}:</span>{" "}
                    <span className="mono">{fmtBeijing(exp.submittedAt)}</span>
                  </span>
                )}
                {exp.approvedBy && (
                  <span>
                    <span className="text-muted">{t("wf.approvedBy")}:</span>{" "}
                    {exp.approvedBy.name}
                  </span>
                )}
                <span>
                  <span className="text-muted">{t("rep.completed")}:</span>{" "}
                  <span className="mono">{fmtBeijing(exp.approvedAt)}</span>
                </span>
              </div>
              {exp.submitNote && (
                <p className="text-[12px] text-charcoal mt-2">
                  <span className="text-muted">{t("wf.submitNote")}:</span>{" "}
                  {exp.submitNote}
                </p>
              )}
              {exp.reviewNote && (
                <p className="text-[13px] leading-relaxed text-ink mt-2 pt-2 border-t border-line">
                  {exp.reviewNote}
                </p>
              )}
            </section>
          )}

          {/* Scientific method */}
          {sciBlocks.length > 0 && (
            <section>
              <h2 className={h2}>{t("rep.method")}</h2>
              <div className="space-y-3">
                {sciBlocks.map((b) => (
                  <div key={b.label}>
                    <div className="text-[10px] font-bold uppercase text-muted">
                      {b.label}
                    </div>
                    <p className="text-[13px] leading-relaxed text-ink">
                      {b.text}
                    </p>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* What was varied — the key variables, however they were entered */}
          {conditions.length > 0 && reportGroups.length > 0 && (
            <section>
              <h2 className={h2}>{t("rep.plan")}</h2>
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="text-left text-[9.5px] uppercase text-muted border-b border-line">
                    <th className="py-1 pr-4 font-bold">{t("res.group")}</th>
                    {conditions.map((c) => (
                      <th key={c.key} className="py-1 pr-4 font-bold">
                        {c.label}
                        {c.unit ? ` (${c.unit})` : ""}
                        {c.process && (
                          <span className="block font-normal normal-case text-muted">
                            {c.process}
                          </span>
                        )}
                      </th>
                    ))}
                    <th className="py-1 font-bold text-right">
                      {t("res.samples")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {reportGroups.map((label) => (
                    <tr key={label} className="border-b border-line/60">
                      <td className="py-1.5 pr-4 mono font-bold">
                        {label}
                        {label === controlGroup && (
                          <span className="font-normal text-muted text-[10px]">
                            {" "}
                            ({t("plan.controlWord")})
                          </span>
                        )}
                      </td>
                      {conditions.map((c) => (
                        <td key={c.key} className="py-1.5 pr-4 mono">
                          {c.byGroup[label] || "—"}
                        </td>
                      ))}
                      <td className="py-1.5 mono text-right">
                        {sampleCountByGroup.get(label) ?? 0}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {anomalies.length > 0 && (
            <section>
              <h2 className={h2}>{t("an.anomalies")}</h2>
              <ul className="space-y-1 text-[12px]">
                {anomalies.map((flag, i) => (
                  <li key={i} className="flex gap-1.5">
                    <span className="text-muted">·</span>
                    <span>
                      {flag.kind === "champion" &&
                        t("anom.champion")
                          .replace("{sample}", flag.sample)
                          .replace("{group}", flag.group ?? "—")
                          .replace("{value}", flag.value.toFixed(2))}
                      {flag.kind === "negativeResistance" &&
                        t("anom.negative")
                          .replace("{sample}", flag.sample)
                          .replace("{metric}", flag.metric)
                          .replace("{value}", flag.value.toFixed(2))}
                      {flag.kind === "outlier" &&
                        t("anom.outlier")
                          .replace("{sample}", flag.sample)
                          .replace("{group}", flag.group)
                          .replace("{value}", flag.value.toFixed(2))
                          .replace("{median}", flag.median.toFixed(2))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Process flow */}
          <section>
            <h2 className={h2}>{t("rep.flow")}</h2>
            <div className="space-y-4">
              {exp.steps.map((st) => (
                <div key={st.id} className="grid grid-cols-[28px_1fr] gap-3">
                  <div className="mono text-[12px] font-bold text-brand-deep pt-0.5">
                    {String(st.position + 1).padStart(2, "0")}
                  </div>
                  <div>
                    <div className="text-[13px] font-bold">{st.name}</div>
                    <div className="text-[11px] text-muted mb-1">
                      {[
                        st.equipment
                          ? `${t("rep.equipment")}: ${st.equipment.name}${st.equipment.assetTag ? ` (${st.equipment.assetTag})` : ""}`
                          : null,
                        st.materials.length
                          ? `${t("rep.materials")}: ${st.materials.map((m) => (m.amount ? `${m.material.name} · ${m.amount}` : m.material.name)).join(", ")}`
                          : null,
                        st.environment
                          ? `${t("rep.environment")}: ${st.environment.name}${Object.entries(
                              (st.environmentConditions ?? {}) as Record<
                                string,
                                string
                              >,
                            )
                              .map(([k, v]) => ` ${k}=${v}`)
                              .join("")}`
                          : null,
                      ]
                        .filter(Boolean)
                        .join("  ·  ")}
                    </div>
                    {st.parameters.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {st.parameters.map((p) => (
                          <span
                            key={p.id}
                            className={
                              "text-[10.5px] px-1.5 py-0.5 rounded-[3px] border mono " +
                              (p.variations.length > 0
                                ? "bg-brand-soft border-brand/50 text-brand-deep font-semibold"
                                : "bg-subtle border-line text-charcoal")
                            }
                          >
                            {p.name}:{" "}
                            {p.variations.length > 0
                              ? p.variations
                                  .map((v) => `${v.variationGroup}=${v.value}`)
                                  .join(" ")
                              : p.value}
                            {p.unit ? ` ${p.unit}` : ""}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Results */}
          {exp.characterizations.some((c) => c.results.length > 0) && (
            <section>
              <h2 className={h2}>{t("rep.results")}</h2>
              <div className="space-y-5">
                {exp.characterizations.map((c) => {
                  const metricNames = [
                    ...new Set(
                      c.results.flatMap((r) =>
                        Object.entries(
                          (r.metrics ?? {}) as Record<string, string>,
                        )
                          .filter(([, v]) => v !== "")
                          .map(([k]) => k),
                      ),
                    ),
                  ];
                  if (metricNames.length === 0) return null;
                  const runNos = [
                    ...new Set(c.results.map((r) => r.run?.runNo ?? 1)),
                  ].sort();
                  return (
                    <div key={c.id}>
                      <div className="text-[12.5px] font-bold mb-1.5">
                        {c.name}
                      </div>
                      <table className="w-full text-[12px]">
                        <thead>
                          <tr className="text-left text-[9.5px] uppercase text-muted border-b border-line">
                            {runNos.length > 1 && (
                              <th className="py-1 pr-3 font-bold">
                                {t("res.run")}
                              </th>
                            )}
                            <th className="py-1 pr-3 font-bold">
                              {t("cap.sample")}
                            </th>
                            <th className="py-1 pr-3 font-bold">
                              {t("res.group")}
                            </th>
                            {metricNames.map((m) => (
                              <th
                                key={m}
                                className="py-1 pr-3 font-bold text-right"
                              >
                                {m}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {runNos.flatMap((rn) =>
                            (groups.length ? groups : [null]).flatMap((g) => {
                              const rows = c.results.filter(
                                (r) =>
                                  (r.run?.runNo ?? 1) === rn &&
                                  (g === null ||
                                    exp.samples.find((s) => s.id === r.sampleId)
                                      ?.variationGroup === g),
                              );
                              const withData = rows.filter((r) =>
                                metricNames.some(
                                  (m) =>
                                    ((r.metrics as Record<string, string>)[m] ??
                                      "") !== "",
                                ),
                              );
                              if (!withData.length) return [];
                              return [
                                ...withData.map((r) => {
                                  const sample = exp.samples.find(
                                    (s) => s.id === r.sampleId,
                                  );
                                  return (
                                    <tr
                                      key={r.id}
                                      className="border-b border-line/60"
                                    >
                                      {runNos.length > 1 && (
                                        <td className="py-1 pr-3 mono">{rn}</td>
                                      )}
                                      <td className="py-1 pr-3 mono">
                                        {sample?.code}
                                      </td>
                                      <td className="py-1 pr-3 mono">
                                        {sample?.variationGroup}
                                        {sample?.variationGroup ===
                                          controlGroup && (
                                          <span className="text-[9px] text-muted">
                                            {" "}
                                            ctrl
                                          </span>
                                        )}
                                      </td>
                                      {metricNames.map((m) => (
                                        <td
                                          key={m}
                                          className="py-1 pr-3 mono text-right"
                                        >
                                          {(
                                            r.metrics as Record<string, string>
                                          )[m] ?? ""}
                                        </td>
                                      ))}
                                    </tr>
                                  );
                                }),
                                g !== null && withData.length > 1 ? (
                                  <tr
                                    key={`${rn}-${g}-mean`}
                                    className="border-b border-line/60 bg-brand-soft/40"
                                  >
                                    <td
                                      colSpan={runNos.length > 1 ? 3 : 2}
                                      className="py-1 pr-3 text-[10px] font-bold text-brand-deep"
                                    >
                                      {g} {t("res.mean")}
                                    </td>
                                    {metricNames.map((m) => {
                                      const nums = withData
                                        .map((r) =>
                                          parseFloat(
                                            (
                                              r.metrics as Record<
                                                string,
                                                string
                                              >
                                            )[m] ?? "",
                                          ),
                                        )
                                        .filter((n) => !isNaN(n));
                                      return (
                                        <td
                                          key={m}
                                          className="py-1 pr-3 mono text-right font-bold text-brand-deep"
                                        >
                                          {mean(nums)}
                                        </td>
                                      );
                                    })}
                                  </tr>
                                ) : null,
                              ];
                            }),
                          )}
                        </tbody>
                      </table>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Deviations & notes */}
          <section>
            <h2 className={h2}>{t("rep.deviations")}</h2>
            {deviations.length === 0 ? (
              <p className="text-[12px] text-muted">{t("rep.noDeviations")}</p>
            ) : (
              <div className="space-y-1.5">
                {deviations.map((d, i) => (
                  <div key={i} className="flex gap-2 text-[12px]">
                    {d.flagged && (
                      <Icon
                        name="Flag"
                        size={12}
                        className="text-warn mt-0.5 shrink-0"
                      />
                    )}
                    <span className="mono text-muted shrink-0">{d.sample}</span>
                    <span className="text-charcoal">
                      <span className="font-semibold">{d.step}</span>
                      {d.text && <span> — {d.text}</span>}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <footer className="border-t border-line pt-4 flex items-center justify-between text-[10px] text-muted">
            <span>{t("rep.generated")}</span>
            <span className="mono">{exp.code}</span>
          </footer>
        </article>
      </div>
    </main>
  );
}
