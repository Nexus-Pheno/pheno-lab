"use client";

import { useState } from "react";
import { useT } from "@/lib/i18n/LanguageProvider";
import { Icon } from "@/components/ui";
import { exportTidyCsv } from "@/lib/actions/analysis";

/** Downloads the tidy table for the current scope, exactly as displayed. */
export function ExportTidyCsv({
  scope,
  disabled,
}: {
  scope: Record<string, string | undefined>;
  disabled: boolean;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);

  const download = async () => {
    setBusy(true);
    try {
      const result = await exportTidyCsv(scope);
      // A BOM so Excel opens the Chinese column headers correctly.
      const blob = new Blob(["﻿" + result.csv], {
        type: "text/csv;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `pheno-analysis-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      onClick={download}
      disabled={disabled || busy}
      className="h-7 px-2.5 rounded-[4px] border border-line bg-surface text-[11.5px] font-semibold text-charcoal hover:bg-subtle disabled:opacity-50 flex items-center gap-1.5"
    >
      <Icon name={busy ? "Loader" : "Download"} size={12} />
      {t("an.export")}
    </button>
  );
}
