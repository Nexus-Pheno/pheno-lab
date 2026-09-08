"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { purgeExperiment, restoreExperiment } from "@/lib/actions/experiments";
import { useT } from "@/lib/i18n/LanguageProvider";
import { Icon } from "@/components/ui";

type Row = {
  id: string;
  code: string;
  title: string;
  isTest: boolean;
  deletedAt: string;
  deletedBy: string;
  samples: number;
  purgeAt: string;
};

export function TrashView({
  rows: initial,
  staff,
}: {
  rows: Row[];
  staff: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const [rows, setRows] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [confirmingPurge, setConfirmingPurge] = useState<string | null>(null);

  const act = async (id: string, run: () => Promise<void>) => {
    setBusy(true);
    setConfirmingPurge(null);
    try {
      await run();
      setRows((list) => list.filter((r) => r.id !== id));
    } finally {
      setBusy(false);
      router.refresh();
    }
  };

  if (rows.length === 0)
    return (
      <p className="text-center text-muted text-[13px] py-14">
        {t("trash.empty")}
      </p>
    );

  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div
          key={r.id}
          className="bg-surface border border-line rounded-[6px] px-4 py-3 flex flex-wrap items-center gap-3"
        >
          <div className="flex-1 min-w-48">
            <div className="flex items-center gap-2">
              <span className="mono text-[12px] font-bold text-brand-deep">
                {r.code}
              </span>
              {r.isTest && (
                <span className="text-[9.5px] font-bold uppercase px-1.5 py-0.5 rounded-[3px] bg-warn-soft border border-warn-line text-warn">
                  {t("dash.newTest")}
                </span>
              )}
            </div>
            <div className="text-[13px] font-medium leading-snug">
              {r.title}
            </div>
            <div className="text-[10.5px] text-muted mt-0.5">
              {t("trash.deletedBy")} {r.deletedBy} · {r.deletedAt} · {r.samples}{" "}
              {t("designer.samples")} · {t("trash.purgeOn")} {r.purgeAt}
            </div>
          </div>
          <button
            disabled={busy}
            onClick={() => act(r.id, () => restoreExperiment(r.id))}
            className="h-8 px-3 bg-brand text-[#243000] rounded-[4px] text-[12px] font-bold disabled:opacity-50 flex items-center gap-1.5"
          >
            <Icon name="Undo2" size={13} />
            {t("trash.restore")}
          </button>
          {staff &&
            (confirmingPurge === r.id ? (
              <span className="flex items-center gap-1 bg-surface border border-warn-line rounded-[4px] px-1.5 py-1">
                <span className="text-[10.5px] font-semibold text-warn">
                  {t("trash.purgeQ")}
                </span>
                <button
                  disabled={busy}
                  onClick={() => act(r.id, () => purgeExperiment(r.id))}
                  className="p-0.5 text-danger"
                  title={t("set.deleteYes")}
                >
                  <Icon name="Check" size={13} />
                </button>
                <button
                  onClick={() => setConfirmingPurge(null)}
                  className="p-0.5 text-muted"
                  title={t("set.deleteNo")}
                >
                  <Icon name="X" size={13} />
                </button>
              </span>
            ) : (
              <button
                disabled={busy}
                onClick={() => setConfirmingPurge(r.id)}
                title={t("trash.purge")}
                className="h-8 px-2.5 border border-line rounded-[4px] text-[12px] font-semibold text-muted hover:text-danger disabled:opacity-50 flex items-center gap-1.5"
              >
                <Icon name="Trash2" size={13} />
                {t("trash.purge")}
              </button>
            ))}
        </div>
      ))}
    </div>
  );
}
