import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { preferredView } from "@/lib/actions/view";
import { getT } from "@/lib/i18n/server";
import { CaptureView } from "@/components/capture/CaptureView";
import {
  getCaptureExperiment,
  getCaptureRunData,
} from "@/modules/experiments/query";
import { getOrCreateRunService } from "@/modules/runs/service";

export default async function CapturePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ run?: string; from?: string }>;
}) {
  const { id } = await params;
  const { run: runParam, from: fromParam } = await searchParams;
  const session = await requireSession();
  const t = await getT();

  const experiment = await getCaptureExperiment(session, id);
  if (!experiment) notFound();

  if (experiment.status !== "IN_LAB" && experiment.status !== "COMPLETE") {
    return (
      <main className="h-full flex items-center justify-center bg-subtle p-6">
        <div className="max-w-md text-center">
          <p className="text-sm text-muted mb-4">{t("cap.notInLab")}</p>
          <Link
            href={`/experiments/${experiment.id}`}
            className="text-[13px] font-semibold text-brand-deep hover:underline"
          >
            {experiment.code} — {experiment.title}
          </Link>
        </div>
      </main>
    );
  }

  await getOrCreateRunService(session, experiment.id);
  const { runs, run, executions, results, layers } = await getCaptureRunData(
    session,
    experiment.id,
    runParam,
  );

  // In portal mode, Back returns to the portal home, not the desktop designer.
  const backHref =
    fromParam === "portal" || (await preferredView()) === "portal"
      ? "/portal"
      : `/experiments/${experiment.id}`;
  return (
    // Keyed by run so switching runs remounts with that run's data — state
    // from the previous run (executions, form drafts) must not leak over.
    <CaptureView
      key={run.id}
      exp={experiment}
      backHref={backHref}
      layers={layers}
      runId={run.id}
      runNo={run.runNo}
      runs={runs.map((r) => ({ id: r.id, runNo: r.runNo }))}
      initialExecutions={executions.map((x) => ({
        stepId: x.stepId,
        sampleId: x.sampleId,
        actuals: (x.actuals ?? {}) as Record<string, string>,
        environmentConditions: (x.environmentConditions ?? {}) as Record<
          string,
          string
        >,
        note: x.note,
        flagged: x.flagged,
        capturedAt: x.capturedAt.toISOString().replace("T", " ").slice(0, 16),
        photos: x.attachments.map((a) => ({ id: a.id, path: a.storedPath })),
      }))}
      initialResults={results.map((r) => ({
        id: r.id,
        characterizationId: r.characterizationId,
        sampleId: r.sampleId ?? "",
        metrics: (r.metrics ?? {}) as Record<string, string>,
        note: r.note,
        source: r.source,
        metricPolicy: r.metricPolicy,
      }))}
    />
  );
}
