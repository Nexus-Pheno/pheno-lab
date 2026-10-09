import Link from "next/link";
import Image from "next/image";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { getT } from "@/lib/i18n/server";
import { getTestingExperiment } from "@/modules/testing/query";
import { TestingRefresh } from "@/components/testing/TestingRefresh";
import { fmtBeijing } from "@/lib/datetime";

function metricsText(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "—";
  return Object.entries(value)
    .filter(([, v]) => typeof v === "number" || typeof v === "string")
    .map(([k, v]) => `${k}: ${v}`)
    .join(" · ");
}

export default async function TestingDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const actor = await requireSession("testing");
  const row = await getTestingExperiment(actor, (await params).id);
  if (!row) notFound();
  const t = await getT();
  return (
    <main className="h-full overflow-y-auto bg-subtle p-4 sm:p-6">
      <div className="max-w-5xl mx-auto space-y-5">
        <Link href="/testing" className="text-sm text-brand-deep">
          ← {t("testing.title")}
        </Link>
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-xl font-bold font-mono break-all">{row.code}</h1>
          <TestingRefresh />
        </div>
        <p className="text-sm text-muted">{t("testing.readOnlyHint")}</p>
        <section className="bg-surface border border-line rounded-lg p-4">
          <h2 className="font-bold mb-2">{t("testing.substrates")}</h2>
          <p className="text-sm font-mono break-words">
            {row.samples
              .map((s) => s.simCode || `${row.code}-${s.code}`)
              .join(" · ")}
          </p>
        </section>
        <section>
          <h2 className="font-bold mb-3">{t("testing.requests")}</h2>
          <div className="space-y-3">
            {row.requests.map((request) => (
              <article
                id={`request-${request.id}`}
                key={request.id}
                className="bg-surface border border-line rounded-lg p-4 scroll-mt-4"
              >
                <p className="text-xs text-muted mb-2">
                  {fmtBeijing(new Date(request.createdAt))} · {t("testing.run")}{" "}
                  {request.runNo}
                </p>
                <p className="font-mono text-sm break-words">
                  {request.samples
                    .map((s) => s.simCode || `${row.code}-${s.code}`)
                    .join(" · ")}
                </p>
                {request.note && (
                  <p className="text-sm whitespace-pre-wrap mt-2">
                    {request.note}
                  </p>
                )}
                <a
                  href={`/api/testing/photos/${request.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="block mt-3"
                >
                  <Image
                    unoptimized
                    width={640}
                    height={480}
                    src={`/api/testing/photos/${request.id}`}
                    alt={t("testing.photo")}
                    className="max-h-64 max-w-full rounded border border-line object-contain"
                  />
                </a>
              </article>
            ))}
          </div>
          {!row.requests.length && (
            <p className="text-sm text-muted">{t("testing.noRequests")}</p>
          )}
        </section>
        <section className="space-y-3">
          <h2 className="font-bold">{t("testing.requirements")}</h2>
          {row.stages.map((stage) => (
            <article
              key={stage.id}
              className="bg-surface border border-line rounded-lg p-4"
            >
              <h3 className="font-semibold">{stage.name}</h3>
              {stage.notes && (
                <p className="text-sm whitespace-pre-wrap mt-2">
                  {stage.notes}
                </p>
              )}
              {stage.settings && (
                <p className="text-sm mt-2 break-words">
                  {metricsText(stage.settings)}
                </p>
              )}
            </article>
          ))}
        </section>
        <section>
          <h2 className="font-bold mb-2">
            {t("testing.data")} · {row.measurementCount}
          </h2>
          <p className="text-xs text-muted mb-3">{t("testing.latest100")}</p>
          <div className="space-y-2">
            {row.measurements.map((scan) => (
              <article
                key={scan.id}
                className="bg-surface border border-line rounded p-3"
              >
                <div className="flex flex-wrap gap-2 justify-between text-sm">
                  <b className="font-mono">{scan.serial}</b>
                  <span className="text-muted">
                    {scan.condition} {scan.direction}
                  </span>
                </div>
                <p className="text-sm mt-1 break-words">
                  {metricsText(scan.metrics)}
                </p>
                <p className="text-xs text-muted mt-1">
                  {fmtBeijing(new Date(scan.measuredAt ?? scan.createdAt))}
                </p>
              </article>
            ))}
          </div>
          {!row.measurements.length && (
            <p className="text-sm text-muted">{t("testing.waiting")}</p>
          )}
        </section>
      </div>
    </main>
  );
}
