"use client";

import { useT } from "@/lib/i18n/LanguageProvider";
import { Icon } from "@/components/ui";

export function PrintButton({ title }: { title?: string }) {
  const t = useT();
  return (
    <button
      onClick={() => {
        // Browsers derive the PDF filename from the document title.
        const prev = document.title;
        if (title) document.title = title;
        window.print();
        if (title) setTimeout(() => (document.title = prev), 1000);
      }}
      className="h-8 bg-ink text-white rounded-[4px] px-3.5 text-[12px] font-semibold flex items-center gap-1.5"
    >
      <Icon name="Printer" size={13} /> {t("rep.print")}
    </button>
  );
}
