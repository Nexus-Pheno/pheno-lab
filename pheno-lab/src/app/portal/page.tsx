import Image from "next/image";
import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { setViewMode } from "@/lib/actions/view";
import { getT } from "@/lib/i18n/server";
import { Icon } from "@/components/ui";
import { listPortalExperiments } from "@/modules/experiments/query";

// The mobile input portal: a touch-first landing that goes straight to data
// capture — no designer, no admin chrome.
export default async function PortalPage() {
  const session = await requireSession();
  const t = await getT();

  const experiments = await listPortalExperiments(session);

  const inLab = experiments.filter((e) => e.status === "IN_LAB");
  const others = experiments.filter((e) => e.status !== "IN_LAB").slice(0, 6);

  async function toDesktop() {
    "use server";
    await setViewMode("desktop");
  }

  return (
    <main className="h-full overflow-y-auto bg-subtle">
      <div className="max-w-lg mx-auto p-4 space-y-4">
        <div className="flex items-center gap-3 pt-1">
          <Image
            src="/brand/pheno-icon.png"
            alt="Pheno"
            width={34}
            height={34}
          />
          <div className="flex-1 min-w-0">
            <h1 className="text-[16px] font-bold leading-tight">
              {t("portal.title")}
            </h1>
            <p className="text-[11.5px] text-muted truncate">
              {t("portal.subtitle")}
            </p>
          </div>
          <Link
            href="/profile"
            title={t("nav.profile")}
            className="shrink-0 w-10 h-10 rounded-full bg-brand-soft border border-brand/40 flex items-center justify-center text-[12px] font-bold text-brand-deep"
          >
            {session.name.slice(0, 2).toUpperCase()}
          </Link>
        </div>

        {inLab.length === 0 ? (
          <p className="text-center text-muted text-[13px] py-12 px-6">
            {t("portal.empty")}
          </p>
        ) : (
          <div className="space-y-2.5">
            {inLab.map((e) => {
              const latestRun = e.runs[0];
              const done = latestRun?._count.executions ?? 0;
              const total = e._count.samples * e._count.steps;
              const pct = total ? Math.round((done / total) * 100) : 0;
              return (
                <Link
                  key={e.id}
                  href={`/experiments/${e.id}/capture`}
                  className="block bg-surface border-2 border-brand/60 rounded-[8px] p-4 active:bg-brand-soft"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="mono text-[12px] font-bold text-brand-deep">
                      {e.code}
                    </span>
                    {latestRun && latestRun.runNo > 1 && (
                      <span className="mono text-[10px] text-muted">
                        {t("cap.run")} {latestRun.runNo}
                      </span>
                    )}
                    <span className="ml-auto mono text-[11px] text-muted">
                      {done}/{total} {t("portal.progress")}
                    </span>
                  </div>
                  <div className="text-[15px] font-semibold leading-snug mb-2.5">
                    {e.title}
                  </div>
                  <div className="h-1.5 bg-subtle rounded-full overflow-hidden mb-2.5">
                    <div
                      className="h-full bg-brand rounded-full"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <div className="flex items-center gap-2 text-brand-deep text-[13px] font-bold">
                    <Icon name="ClipboardPen" size={16} />
                    {t("portal.captureNow")}
                    <Icon name="ChevronRight" size={16} className="ml-auto" />
                  </div>
                </Link>
              );
            })}
          </div>
        )}

        {others.length > 0 && (
          <div>
            <h2 className="text-[11px] font-bold uppercase text-muted mb-1.5 px-1">
              {t("portal.other")}
            </h2>
            <div className="space-y-1.5">
              {others.map((e) => (
                <Link
                  key={e.id}
                  href={`/experiments/${e.id}`}
                  className="flex items-center gap-2.5 bg-surface border border-line rounded-[6px] px-3.5 py-2.5"
                >
                  <span className="mono text-[11px] font-bold text-muted">
                    {e.code}
                  </span>
                  <span className="text-[12.5px] flex-1 truncate">
                    {e.title}
                  </span>
                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-[3px] bg-subtle border border-line text-muted">
                    {t(`status.${e.status}` as "status.DRAFT")}
                  </span>
                </Link>
              ))}
            </div>
          </div>
        )}

        <form action={toDesktop} className="pt-2 pb-6 text-center">
          <button className="text-[12px] font-semibold text-muted underline underline-offset-2">
            {t("portal.toDesktop")}
          </button>
        </form>
      </div>
    </main>
  );
}
