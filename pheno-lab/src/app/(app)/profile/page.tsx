import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { getT } from "@/lib/i18n/server";
import { ProfileForms } from "@/components/profile/ProfileForms";
import { Icon } from "@/components/ui";
import { AiProviders } from "@/components/profile/AiProviders";
import { FeedbackBoard } from "@/components/feedback/FeedbackBoard";
import { getProfileData, listMyFeedback } from "@/modules/accounts/query";
import { getSystemStatus } from "@/modules/system/query";

export default async function ProfilePage() {
  const session = await requireSession();
  const t = await getT();
  const [{ user, organization: org, aiProviders, statistics }, myFeedback] =
    await Promise.all([getProfileData(session), listMyFeedback(session)]);

  const stats: { label: string; value: string | number; icon: string }[] = [
    {
      label: t("profile.statExperiments"),
      value: statistics.experiments,
      icon: "FlaskConical",
    },
    {
      label: t("profile.statCompleted"),
      value: statistics.completed,
      icon: "CheckCircle2",
    },
    {
      label: t("profile.statSamples"),
      value: statistics.samples,
      icon: "Grid3x3",
    },
    {
      label: t("profile.statDataPoints"),
      value: statistics.dataPoints,
      icon: "Database",
    },
    {
      label: t("profile.statPresets"),
      value: statistics.presets,
      icon: "Bookmark",
    },
  ];

  // Admins also see how full the server's data disk is.
  if (session.role === "ADMIN") {
    try {
      const { storage } = await getSystemStatus(session);
      if (storage.diskTotalBytes && storage.diskFreeBytes !== null) {
        const usedBytes = storage.diskTotalBytes - storage.diskFreeBytes;
        const gb = (n: number) => (n / 1_000_000_000).toFixed(1);
        stats.push({
          label: t("profile.statDisk")
            .replace("{used}", gb(usedBytes))
            .replace("{total}", gb(storage.diskTotalBytes)),
          value: `${Math.round((usedBytes / storage.diskTotalBytes) * 100)}%`,
          icon: "HardDrive",
        });
      }
    } catch {
      // A missing filesystem reading never breaks the profile page.
    }
  }

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
          <div className={"grid grid-cols-2 gap-2.5 " + (stats.length > 5 ? "sm:grid-cols-3" : "sm:grid-cols-5")}>
            {stats.map((s) => (
              <div
                key={s.label}
                className="bg-surface border border-line rounded-[6px] p-3 text-center"
              >
                <Icon
                  name={s.icon}
                  size={15}
                  className="mx-auto text-brand-deep mb-1"
                />
                <div className="mono text-[18px] font-bold">{s.value}</div>
                <div className="text-[10px] text-muted leading-tight mt-0.5">
                  {s.label}
                </div>
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

        {/* The team's feedback channel: file one problem per item with
            screenshots, and follow the admin's verdict right here. */}
        <section className="bg-surface border border-line rounded-[6px] p-4">
          <h2 className="text-[13px] font-bold mb-1 flex items-center gap-1.5">
            <Icon name="Bug" size={14} className="text-charcoal" /> {t("fb.boardTitle")}
          </h2>
          <p className="text-[11px] text-muted mb-3">{t("fb.boardHint")}</p>
          <FeedbackBoard
            isAdmin={false}
            items={myFeedback.map((f) => ({
              id: f.id,
              kind: f.kind,
              title: f.title,
              message: f.message,
              screenshotPath: f.screenshotPath,
              attachments: f.attachments,
              errorLog: f.errorLog,
              pageUrl: f.pageUrl,
              status: f.status,
              adminNote: f.adminNote,
              reviewedBy: f.reviewedBy?.name ?? "",
              createdAt: f.createdAt.toISOString().replace("T", " ").slice(0, 16),
              userName: f.user.name,
              userEmail: f.user.email,
            }))}
          />
        </section>

        {session.role === "ADMIN" && <AiProviders rows={aiProviders} />}

        {session.role !== "TECHNICIAN" && (
          <div className="flex flex-wrap gap-4 mb-2">
            <Link
              href="/ingest"
              className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-brand-deep hover:underline"
            >
              <Icon name="Inbox" size={13} /> {t("ing.manage")}
            </Link>
            <Link
              href="/exports"
              className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-brand-deep hover:underline"
            >
              <Icon name="Download" size={13} /> {t("exp.nav")}
            </Link>
            <Link
              href="/test-data"
              className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-warn hover:underline"
            >
              <Icon name="FlaskConical" size={13} /> {t("test.nav")}
            </Link>
          </div>
        )}

        {session.role === "ADMIN" && (
          <div className="flex flex-wrap gap-4">
            <Link
              href="/feedback"
              className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-brand-deep hover:underline"
            >
              <Icon name="Inbox" size={13} /> {t("fb.viewAll")}
            </Link>
            <Link
              href="/organization"
              className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-brand-deep hover:underline"
            >
              <Icon name="Users" size={13} /> {t("org.manage")}
            </Link>
            <Link
              href="/system"
              className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-brand-deep hover:underline"
            >
              <Icon name="HardDrive" size={13} /> {t("sys.manage")}
            </Link>
            <Link
              href="/instruments"
              className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-brand-deep hover:underline"
            >
              <Icon name="Radio" size={13} /> {t("inst.manage")}
            </Link>
          </div>
        )}
      </div>
    </main>
  );
}
