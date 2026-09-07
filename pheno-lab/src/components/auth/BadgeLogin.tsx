"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import { useT } from "@/lib/i18n/LanguageProvider";
import { Icon } from "@/components/ui";
import { badgeLogin } from "@/lib/actions/badges";
import {
  canonicalBadgeUid,
  newNdefReader,
  nfcSupported,
  tokenFromRecords,
} from "@/lib/nfc";

const emptySubscribe = () => () => {};

/**
 * Tap-your-badge sign-in on a registered shared tablet. Rendered only when
 * the login page knows it is on a shared device; shows only where Web NFC
 * exists (Chrome/Edge on Android). One button press arms the reader — the
 * browser requires a user gesture — then every tap attempts a login until
 * the page navigates away.
 */
export function BadgeLogin() {
  const t = useT();
  // Hydration-safe capability check: false on the server, real answer after.
  const supported = useSyncExternalStore(
    emptySubscribe,
    nfcSupported,
    () => false,
  );
  const [phase, setPhase] = useState<"idle" | "armed" | "checking" | "failed">(
    "idle",
  );
  const busy = useRef(false);

  const arm = async () => {
    setPhase("armed");
    try {
      const reader = newNdefReader();
      reader.addEventListener("reading", (event) => {
        if (busy.current) return;
        busy.current = true;
        setPhase("checking");
        const uid = canonicalBadgeUid(event.serialNumber);
        const token = tokenFromRecords(event.message.records);
        void badgeLogin(uid, token)
          .then((r) => {
            if (r.ok) {
              // Full reload so the new session cookie drives everything.
              window.location.href = "/portal";
            } else {
              setPhase("failed");
              busy.current = false;
            }
          })
          .catch(() => {
            setPhase("failed");
            busy.current = false;
          });
      });
      await reader.scan();
    } catch {
      setPhase("failed");
    }
  };

  if (!supported) return null;

  return (
    <div className="mt-3">
      {phase === "idle" && (
        <button
          type="button"
          onClick={arm}
          className="w-full h-11 border-2 border-brand/50 bg-brand-soft/40 text-brand-deep rounded-[6px] text-[13.5px] font-bold flex items-center justify-center gap-2"
        >
          <Icon name="Nfc" size={16} /> {t("nfc.loginBtn")}
        </button>
      )}
      {phase === "armed" && (
        <p className="text-[12.5px] font-bold text-brand-deep flex items-center justify-center gap-2 h-11 border-2 border-dashed border-brand/50 rounded-[6px]">
          <Icon name="Loader2" size={15} className="animate-spin" />
          {t("nfc.loginTap")}
        </p>
      )}
      {phase === "checking" && (
        <p className="text-[12.5px] font-bold text-brand-deep flex items-center justify-center gap-2 h-11">
          <Icon name="Loader2" size={15} className="animate-spin" />
          {t("nfc.loginChecking")}
        </p>
      )}
      {phase === "failed" && (
        <div className="text-center">
          <p className="text-[12px] text-danger mb-1">{t("nfc.loginFailed")}</p>
          <button
            type="button"
            onClick={() => setPhase("idle")}
            className="text-[12px] font-semibold text-brand-deep hover:underline"
          >
            {t("nfc.loginRetry")}
          </button>
        </div>
      )}
    </div>
  );
}
