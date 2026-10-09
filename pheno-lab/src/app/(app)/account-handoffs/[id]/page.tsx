import { notFound } from "next/navigation";
import { requireSession, assertPersonalDevice } from "@/lib/auth";
import { getT } from "@/lib/i18n/server";
import { getAccountHandoff } from "@/modules/accounts/provisioning-service";
import { AccountHandoff } from "@/components/testing/AccountHandoff";
import { fmtBeijing } from "@/lib/datetime";

export default async function HandoffPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireSession();
  assertPersonalDevice(session);
  const { id } = await params;
  const handoff = await getAccountHandoff(session, id).catch(() => null);
  if (!handoff) notFound();
  const t = await getT();
  return (
    <main className="h-full overflow-y-auto bg-subtle p-4 sm:p-8">
      <section className="max-w-lg mx-auto bg-surface border border-line rounded-lg p-5 space-y-4">
        <h1 className="text-xl font-bold">{t("testing.handoffTitle")}</h1>
        <p className="font-semibold">{handoff.name}</p>
        <p className="text-sm text-muted">{t("testing.handoffHint")}</p>
        <label className="block text-sm">
          {t("login.email")}
          <input
            readOnly
            value={handoff.email}
            className="block mt-1 w-full border border-line rounded p-3 font-mono text-sm"
          />
        </label>
        <p className="text-sm">
          {t("testing.expires")}: {fmtBeijing(new Date(handoff.expiresAt))}
        </p>
        {handoff.available ? (
          <AccountHandoff id={id} />
        ) : (
          <p className="text-sm text-muted">
            {t("testing.handoffUnavailable")}
          </p>
        )}
      </section>
    </main>
  );
}
