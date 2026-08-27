"use client";

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n/LanguageProvider";
import { Icon } from "@/components/ui";

// iOS has no install prompt API; Add to Home Screen from the share sheet is
// the only path, so there the button opens instructions instead.
function isIos(): boolean {
  const ua = navigator.userAgent;
  return (
    /iPhone|iPad|iPod/.test(ua) ||
    // iPadOS reports as macOS but has touch.
    (ua.includes("Macintosh") && navigator.maxTouchPoints > 1)
  );
}

/**
 * Android Chrome with install support: triggers the native install prompt.
 * iOS: shows Add-to-Home-Screen instructions. Hidden when already installed
 * or when neither path applies.
 */
export function InstallAppButton() {
  const t = useT();
  const [mode, setMode] = useState<"hidden" | "prompt" | "ios">("hidden");
  const [showIosHelp, setShowIosHelp] = useState(false);

  useEffect(() => {
    if (window.matchMedia("(display-mode: standalone)").matches) return;
    if ((navigator as { standalone?: boolean }).standalone) return;
    const check = () => {
      if (window.__phenoInstallPrompt) setMode("prompt");
      else if (isIos()) setMode("ios");
    };
    check();
    window.addEventListener("pheno-install-ready", check);
    window.addEventListener("appinstalled", () => setMode("hidden"));
    return () => window.removeEventListener("pheno-install-ready", check);
  }, []);

  if (mode === "hidden") return null;

  const install = async () => {
    if (mode === "ios") {
      setShowIosHelp((v) => !v);
      return;
    }
    const prompt = window.__phenoInstallPrompt;
    if (!prompt) return;
    await prompt.prompt();
    window.__phenoInstallPrompt = undefined;
    setMode("hidden");
  };

  return (
    <div className="space-y-2">
      <button
        onClick={install}
        className="w-full h-11 flex items-center justify-center gap-2 bg-ink text-white rounded-[6px] text-[13px] font-semibold"
      >
        <Icon name="Download" size={15} />
        {t("portal.install")}
      </button>
      {mode === "ios" && showIosHelp && (
        <div className="bg-surface border border-line rounded-[6px] p-3 space-y-1.5">
          <p className="text-[12px] font-bold">{t("portal.iosTitle")}</p>
          <p className="text-[12px] text-charcoal flex items-center gap-1.5 flex-wrap">
            1. {t("portal.iosStep1")}
            <Icon name="Share" size={13} className="text-brand-deep" />
          </p>
          <p className="text-[12px] text-charcoal flex items-center gap-1.5 flex-wrap">
            2. {t("portal.iosStep2")}
            <Icon name="SquarePlus" size={13} className="text-brand-deep" />
          </p>
          <p className="text-[11px] text-muted">{t("portal.iosHint")}</p>
        </div>
      )}
    </div>
  );
}
