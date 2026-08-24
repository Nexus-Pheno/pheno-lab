"use client";

import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n/LanguageProvider";

// History-aware back: returns to wherever the user actually came from
// (capture portal, designer, board) instead of a hardcoded route.
export function SmartBack({ fallback }: { fallback: string }) {
  const router = useRouter();
  const t = useT();
  return (
    <button
      onClick={() => {
        if (window.history.length > 1) router.back();
        else router.push(fallback);
      }}
      className="h-8 flex items-center px-2.5 text-[12px] font-semibold text-brand-deep border border-line rounded-[4px] hover:bg-subtle"
    >
      {t("nav.back")}
    </button>
  );
}
