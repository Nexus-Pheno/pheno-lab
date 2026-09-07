"use client";

import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n/LanguageProvider";
import { logout } from "@/lib/actions/auth";

// Client half of the kiosk idle timeout. The server enforces the real 15-min
// cutoff; this warns two minutes early so a technician mid-entry can keep the
// session (any touch resets it), and cleanly signs out instead of leaving a
// stale screen for the next person to find.
const WARN_AFTER_MS = 13 * 60_000;
const GRACE_MS = 2 * 60_000;

export function IdleGuard() {
  const t = useT();
  const [warning, setWarning] = useState(false);
  const [left, setLeft] = useState(GRACE_MS / 1000);
  const lastActivity = useRef(0);

  useEffect(() => {
    lastActivity.current = Date.now();
    const touch = () => {
      lastActivity.current = Date.now();
      setWarning(false);
    };
    const events = ["pointerdown", "keydown", "touchstart", "scroll"] as const;
    for (const e of events) window.addEventListener(e, touch, { passive: true });

    const tick = setInterval(() => {
      const idle = Date.now() - lastActivity.current;
      if (idle >= WARN_AFTER_MS + GRACE_MS) {
        clearInterval(tick);
        void logout();
      } else if (idle >= WARN_AFTER_MS) {
        setWarning(true);
        setLeft(Math.max(0, Math.ceil((WARN_AFTER_MS + GRACE_MS - idle) / 1000)));
      }
    }, 1000);

    return () => {
      clearInterval(tick);
      for (const e of events) window.removeEventListener(e, touch);
    };
  }, []);

  if (!warning) return null;
  return (
    <div className="fixed inset-0 z-[100] bg-ink/70 flex items-center justify-center p-6">
      <div className="bg-surface rounded-[8px] p-6 max-w-xs w-full text-center">
        <p className="text-[15px] font-bold mb-1">{t("kiosk.idleTitle")}</p>
        <p className="text-[13px] text-charcoal mb-4">
          {t("kiosk.idleBody", { s: String(left) })}
        </p>
        <button
          onClick={() => {
            lastActivity.current = Date.now();
            setWarning(false);
          }}
          className="w-full bg-brand text-[#243000] rounded-[4px] py-2.5 text-sm font-bold"
        >
          {t("kiosk.idleStay")}
        </button>
      </div>
    </div>
  );
}
