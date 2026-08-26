"use client";

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n/LanguageProvider";
import { Icon } from "@/components/ui";

// Shown only when the browser has offered an install prompt (Chrome with
// install support) and the app is not already running installed. On browsers
// that never fire the prompt — e.g. Android without Google services, or
// iOS — the button stays hidden and the menu's Add to Home Screen remains
// the way in.
export function InstallAppButton() {
  const t = useT();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (window.matchMedia("(display-mode: standalone)").matches) return;
    const check = () => setReady(Boolean(window.__phenoInstallPrompt));
    check();
    window.addEventListener("pheno-install-ready", check);
    window.addEventListener("appinstalled", () => setReady(false));
    return () => window.removeEventListener("pheno-install-ready", check);
  }, []);

  if (!ready) return null;

  const install = async () => {
    const prompt = window.__phenoInstallPrompt;
    if (!prompt) return;
    await prompt.prompt();
    window.__phenoInstallPrompt = undefined;
    setReady(false);
  };

  return (
    <button
      onClick={install}
      className="w-full h-11 flex items-center justify-center gap-2 bg-ink text-white rounded-[6px] text-[13px] font-semibold"
    >
      <Icon name="Download" size={15} />
      {t("portal.install")}
    </button>
  );
}
