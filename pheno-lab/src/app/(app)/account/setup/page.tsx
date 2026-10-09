import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { getT } from "@/lib/i18n/server";
import { FirstPassword } from "@/components/testing/FirstPassword";

export default async function SetupPage() {
  const session = await requireSession("setup");
  if (!session.mustChangePassword)
    redirect(session.testingOnly ? "/testing" : "/");
  const t = await getT();
  return (
    <main className="h-full overflow-y-auto bg-subtle p-4 sm:p-8">
      <section className="max-w-md mx-auto bg-surface border border-line rounded-lg p-5 space-y-4">
        <h1 className="text-xl font-bold">{t("testing.setupTitle")}</h1>
        <p className="text-sm text-muted">{t("testing.setupHint")}</p>
        <FirstPassword destination={session.testingOnly ? "/testing" : "/"} />
      </section>
    </main>
  );
}
