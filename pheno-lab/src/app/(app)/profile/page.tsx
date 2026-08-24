import Link from "next/link";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { canViewWhere } from "@/lib/actions/experiments";
import { getT } from "@/lib/i18n/server";
import { ProfileForms, FeedbackForm } from "@/components/profile/ProfileForms";
import { Icon } from "@/components/ui";
import { listAiProviders } from "@/lib/actions/ai";
import { AiProviders } from "@/components/profile/AiProviders";

export default async function ProfilePage() {
  const session = await requireSession();
  const t = await getT();
  const aiProviders = session.role === "ADMIN" ? await listAiProviders() : [];

  const [user, org] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: session.uid } }),
    db.organization.findUniqueOrThrow({ where: { id: session.org } }),
  ]);

  // Stats over the experiments this user can see / is involved in.
  const where = await canViewWhere(session);
  const [experiments, completed, presetCount] = await Promise.all([
    db.experiment.findMany({
      where,
      select: {
        id: true,
        _count: { select: { samples: true } },
        steps: { select: { _count: { select: { parameters: true, materials: true } }, parameters: { select: { _count: { select: { variations: true } } } } } },
        characterizations: { select: { settings: true } },
      },
    }),
    db.experiment.count({ where: { ...where, status: "COMPLETE" } }),
    db.preset.count({ where: { organizationId: session.org, createdById: session.uid } }),
  ]);

  let samples = 0;
  let dataPoints = 0;
  for (const e of experiments) {
    samples += e._count.samples;
    for (const s of e.steps) {
      dataPoints += s._count.parameters + s._count.materials;
      for (const p of s.parameters) dataPoints += p._count.variations;
    }
    for (const c of e.characterizations) {
      dataPoints += Object.keys((c.settings ?? {}) as object).length;
    }
  }

  const stats = [
    { label: t("profile.statExperiments"), value: experiments.length, icon: "FlaskConical" },
    { label: t("profile.statCompleted"), value: completed, icon: "CheckCircle2" },
    { label: t("profile.statSamples"), value: samples, icon: "Grid3x3" },
    { label: t("profile.statDataPoints"), value: dataPoints, icon: "Database" },
    { label: t("profile.statPresets"), value: presetCount, icon: "Bookmark" },
  ];

  return (
    <main className="h-full overflow-y-auto bg-subtle">
      <div className="max-w-3xl mx-auto p-6 space-y-6">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-full bg-brand-soft border border-brand/40 flex items-center justify-center text-[16px] font-bold text-brand-deep">
            {user.name.slice(0, 2).toUpperCase()}
          </div>
          <div>
            <h1 className="text-lg font-bold">{user.name}</h1>
            <p className="text-xs text-muted">
              {user.handle && <span className="mono">{user.handle} · </span>}
              {org.name} · {t(`role.${user.role}` as "role.ADMIN")}
            </p>
          </div>
        </div>

        {/* Stats */}
        <section>
          <h2 className="text-[13px] font-bold mb-2">{t("profile.stats")}</h2>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
            {stats.map((s) => (
              <div key={s.label} className="bg-surface border border-line rounded-[6px] p-3 text-center">
                <Icon name={s.icon} size={15} className="mx-auto text-brand-deep mb-1" />
                <div className="mono text-[18px] font-bold">{s.value}</div>
                <div className="text-[10px] text-muted leading-tight mt-0.5">{s.label}</div>
              </div>
            ))}
          </div>
        </section>

        <ProfileForms
          user={{
            name: user.name,
            handle: user.handle,
            email: user.email,
            language: user.language === "zh" ? "zh" : "en",
            role: user.role,
            createdAt: user.createdAt.toISOString().slice(0, 10),
          }}
          orgName={org.name}
        />

        <FeedbackForm />

        {session.role === "ADMIN" && <AiProviders rows={aiProviders} />}

        {session.role !== "TECHNICIAN" && (
          <div className="flex flex-wrap gap-4 mb-2">
            <Link href="/ingest" className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-brand-deep hover:underline">
              <Icon name="Inbox" size={13} /> {t("ing.manage")}
            </Link>
            <Link href="/exports" className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-brand-deep hover:underline">
              <Icon name="Download" size={13} /> {t("exp.nav")}
            </Link>
            <Link href="/test-data" className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-warn hover:underline">
              <Icon name="FlaskConical" size={13} /> {t("test.nav")}
            </Link>
          </div>
        )}

        {session.role === "ADMIN" && (
          <div className="flex flex-wrap gap-4">
            <Link href="/feedback" className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-brand-deep hover:underline">
              <Icon name="Inbox" size={13} /> {t("fb.viewAll")}
            </Link>
            <Link href="/organization" className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-brand-deep hover:underline">
              <Icon name="Users" size={13} /> {t("org.manage")}
            </Link>
            <Link href="/system" className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-brand-deep hover:underline">
              <Icon name="HardDrive" size={13} /> {t("sys.manage")}
            </Link>
            <Link href="/instruments" className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-brand-deep hover:underline">
              <Icon name="Radio" size={13} /> {t("inst.manage")}
            </Link>

          </div>
        )}
      </div>
    </main>
  );
}
