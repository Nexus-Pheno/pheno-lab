"use client";

import { useEffect } from "react";

// Chrome fires beforeinstallprompt once, early; whoever wants to offer an
// install button later needs the event kept around.
declare global {
  interface Window {
    __phenoInstallPrompt?: Event & { prompt: () => Promise<void> };
  }
}

// Registers the install-criteria service worker (public/sw.js) and stashes
// the browser's install prompt for InstallAppButton.
export function PwaRegister() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
    const onPrompt = (e: Event) => {
      e.preventDefault();
      window.__phenoInstallPrompt = e as Window["__phenoInstallPrompt"];
      window.dispatchEvent(new Event("pheno-install-ready"));
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);
  return null;
}
