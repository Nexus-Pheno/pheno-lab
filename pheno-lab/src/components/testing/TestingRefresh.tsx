"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n/LanguageProvider";

export function TestingRefresh() {
  const router = useRouter();
  const t = useT();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), 60_000);
    return () => clearInterval(timer);
  }, [router]);
  return (
    <button
      onClick={() => router.refresh()}
      className="text-sm border border-line rounded px-3 py-2 bg-surface"
    >
      {t("testing.refresh")}
    </button>
  );
}
