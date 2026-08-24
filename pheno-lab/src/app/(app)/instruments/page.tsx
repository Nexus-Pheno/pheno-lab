import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { getT } from "@/lib/i18n/server";
import { Icon } from "@/components/ui";
import { InstrumentsView, type RigRow, type SampleOption } from "@/components/instruments/InstrumentsView";
import type { JvFileRow } from "@/lib/actions/instruments";

// Freshness is resolved server-side, per request — a client component may not
// read the clock during render.
function describeLastSeen(d: Date | null): string | null {
  if (!d) return null;
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** The agents beat every two minutes; ten is generous before we call one down. */
function isFresh(d: Date | null): boolean {
  return d != null && Date.now() - d.getTime() < 10 * 60 * 1000;
}

// Where instrument data lands: what the simulators have pushed, what matched a
// sample, and what still needs a human. Files arrive on their own — nothing on
// this page has to be run for ingestion to happen.
export default async function InstrumentsPage() {
  const session = await requireSession();
  const t = await getT();

  const ROW_SELECT = {
    id: true,
    serial: true,
    direction: true,
    measuredAt: true,
    metrics: true,
    status: true,
    matchNote: true,
    imagePath: true,
    instrument: { select: { name: true } },
    sample: { select: { code: true } },
  } as const;

  const [instruments, matchedRaw, unmatchedRaw, experiments] = await Promise.all([
    db.instrument.findMany({
      where: { organizationId: session.org },
      orderBy: { name: "asc" },
      include: { _count: { select: { uploads: true, measurements: true } } },
    }),
    db.jvMeasurement.findMany({
      where: { organizationId: session.org, status: "MATCHED" },
      select: ROW_SELECT,
      orderBy: { measuredAt: "desc" },
      take: 100,
    }),
    db.jvMeasurement.findMany({
      where: { organizationId: session.org, status: "UNMATCHED" },
      select: ROW_SELECT,
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    // Samples an unmatched file can be attached to by hand.
    db.experiment.findMany({
      where: { isTest: false, organizationId: session.org, status: { in: ["DRAFT", "IN_LAB", "REVIEW"] } },
      select: { code: true, samples: { select: { id: true, code: true } } },
      orderBy: { createdAt: "desc" },
      take: 40,
    }),
  ]);

  const toRow = (m: (typeof matchedRaw)[number]): JvFileRow => {
    const metrics = (m.metrics ?? {}) as Record<string, number | undefined>;
    const n = (v: number | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    return {
      id: m.id,
      serial: m.serial,
      sampleCode: m.sample?.code ?? null,
      direction: m.direction,
      instrument: m.instrument.name,
      measuredAt: m.measuredAt ? m.measuredAt.toISOString() : null,
      pce: n(metrics.pce),
      voc: n(metrics.voc),
      jsc: n(metrics.jsc),
      ff: n(metrics.ff),
      status: m.status,
      matchNote: m.matchNote,
      imagePath: m.imagePath,
    };
  };

  const rigs: RigRow[] = instruments.map((i) => ({
    id: i.id,
    name: i.name,
    kind: i.kind,
    hostname: i.hostname,
    agentVersion: i.agentVersion,
    watchDirs: i.watchDirs,
    lastSeenLabel: describeLastSeen(i.lastSeenAt),
    fresh: isFresh(i.lastSeenAt),
    lastError: i.lastError,
    uploads: i._count.uploads,
    measurements: i._count.measurements,
  }));

  const samples: SampleOption[] = experiments.flatMap((e) =>
    e.samples
      .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }))
      .map((s) => ({ id: s.id, label: `${e.code}-${s.code}` })),
  );

  return (
    <main className="h-full overflow-y-auto bg-subtle">
      <div className="max-w-5xl mx-auto p-3 sm:p-6 space-y-5">
        <div>
          <h1 className="text-lg font-bold flex items-center gap-2">
            <Icon name="Radio" size={17} className="text-brand-deep" /> {t("inst.title")}
          </h1>
          <p className="text-xs text-muted">{t("inst.subtitle")}</p>
        </div>
        <InstrumentsView
          rigs={rigs}
          matched={matchedRaw.map(toRow)}
          unmatched={unmatchedRaw.map(toRow)}
          samples={samples}
          canManage={session.role !== "TECHNICIAN"}
        />
      </div>
    </main>
  );
}
