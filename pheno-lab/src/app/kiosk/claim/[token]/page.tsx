import Image from "next/image";
import { getT } from "@/lib/i18n/server";
import { peekSetupToken } from "@/modules/accounts/device-service";
import { claimDevice } from "@/lib/actions/devices";

// Opened ON the tablet from the registration link the admin handed out. The
// technician holding the device names it (that name is what the admin's
// master list shows) and confirms — which pins the shared-device cookie into
// this browser. A button, not an automatic GET side effect, so a link
// preview or prefetch cannot consume the one-time token.
export default async function ClaimPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const t = await getT();
  const device = await peekSetupToken(token).catch(() => null);

  return (
    <main className="min-h-dvh bg-subtle flex items-center justify-center p-6">
      <div className="w-full max-w-sm bg-surface border border-line rounded-[8px] p-8 text-center">
        <Image
          src="/brand/pheno-logo.png"
          alt="Pheno"
          width={120}
          height={35}
          className="mx-auto mb-4"
          priority
        />
        {device ? (
          <>
            <h1 className="text-[15px] font-bold mb-1">
              {t("kiosk.claimTitle")}
            </h1>
            <p className="text-[12px] text-muted mb-4">{t("kiosk.claimHint")}</p>
            <form
              action={async (formData: FormData) => {
                "use server";
                await claimDevice(token, String(formData.get("label") ?? ""));
              }}
              className="space-y-3 text-left"
            >
              <div>
                <label
                  htmlFor="label"
                  className="block text-[11px] font-bold uppercase text-muted mb-1"
                >
                  {t("kiosk.nameField")}
                </label>
                <input
                  id="label"
                  name="label"
                  required
                  maxLength={120}
                  placeholder={t("kiosk.labelPh")}
                  className="w-full border border-line rounded-[4px] px-3 py-2 text-sm"
                />
                <p className="text-[10.5px] text-muted mt-1">
                  {t("kiosk.nameHint")}
                </p>
              </div>
              <button className="w-full bg-brand text-[#243000] rounded-[4px] py-2.5 text-sm font-bold">
                {t("kiosk.claimConfirm")}
              </button>
            </form>
          </>
        ) : (
          <p className="text-[13px] text-charcoal">{t("kiosk.claimInvalid")}</p>
        )}
      </div>
    </main>
  );
}
