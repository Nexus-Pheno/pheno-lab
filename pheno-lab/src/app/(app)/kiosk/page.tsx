import { notFound } from "next/navigation";
import { requireSession, assertPersonalDevice } from "@/lib/auth";
import { getT } from "@/lib/i18n/server";
import { listDevices } from "@/modules/accounts/device-service";
import { KioskManager } from "@/components/kiosk/KioskManager";

// Admin console for the lab's shared tablets: register a tablet, hand its
// one-time setup link to whoever holds the device, see who is signed in
// where, and cut a lost tablet off.
export default async function KioskPage() {
  const session = await requireSession();
  if (session.role !== "ADMIN") notFound();
  assertPersonalDevice(session);
  const t = await getT();
  const devices = await listDevices(session);

  return (
    <main className="h-full overflow-y-auto bg-subtle">
      <div className="max-w-3xl mx-auto p-4 sm:p-6">
        <h1 className="text-lg font-bold">{t("kiosk.title")}</h1>
        <p className="text-xs text-muted mb-4">{t("kiosk.subtitle")}</p>
        <KioskManager devices={devices} />
      </div>
    </main>
  );
}
