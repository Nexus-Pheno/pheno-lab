"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { backupNow } from "@/lib/actions/system";
import { useT } from "@/lib/i18n/LanguageProvider";
import { Icon } from "@/components/ui";

export function BackupButton() {
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  return (
    <span className="flex items-center gap-2">
      {msg && <span className="text-[11px] text-brand-deep">{msg}</span>}
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const res = await backupNow();
          setBusy(false);
          setMsg(res.ok ? t("sys.backupDone") : res.message);
          router.refresh();
        }}
        className="bg-ink text-white rounded-[4px] px-3.5 py-1.5 text-[12px] font-semibold disabled:opacity-50 flex items-center gap-1.5"
      >
        <Icon name="DatabaseBackup" size={13} />
        {busy ? "…" : t("sys.backupNow")}
      </button>
    </span>
  );
}
