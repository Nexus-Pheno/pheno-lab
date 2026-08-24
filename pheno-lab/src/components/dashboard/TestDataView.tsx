"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { clearTestData, setExperimentTestMode } from "@/lib/actions/experiments";
import { useT } from "@/lib/i18n/LanguageProvider";
import { Icon } from "@/components/ui";

export type TestRow = {
  id: string;
  code: string;
  title: string;
  status: string;
  createdBy: string;
  createdAt: string;
  samples: number;
  steps: number;
  runs: number;
};

export function TestDataView({ rows, isAdmin }: { rows: TestRow[]; isAdmin: boolean }) {
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const [done, setDone] = useState<number | null>(null);

  const totalSamples = rows.reduce((n, r) => n + r.samples, 0);

  return (
    <div className="space-y-4">
      <p className="text-[12px] text-warn bg-warn-soft border border-warn-line rounded-[4px] px-3 py-2">
        {t("test.explain")}
      </p>

      {done !== null && (
        <p className="text-[12.5px] font-semibold bg-surface border border-line rounded-[6px] px-3 py-2">
          {t("test.cleared").replace("{n}", String(done))}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12.5px] font-bold">
          {rows.length} {t("test.experiments")}
        </span>
        <span className="text-[11.5px] text-muted mono">{totalSamples} {t("ing.samples")}</span>
        <span className="flex-1" />
        {isAdmin && rows.length > 0 && (
          confirming ? (
            <span className="flex flex-wrap items-center gap-2 bg-danger-soft border border-danger-line rounded-[4px] px-2.5 py-1.5">
              <span className="text-[11.5px] font-semibold text-danger">
                {t("test.confirm").replace("{n}", String(rows.length))}
              </span>
              {/* Typing the word is deliberate: this cascade removes samples,
                  runs, captures and results, and cannot be undone. */}
              <input
                autoFocus
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder="DELETE"
                className="h-7 w-24 border border-danger-line rounded-[4px] px-2 text-[11.5px] mono bg-surface"
              />
              <button
                disabled={busy || typed !== "DELETE"}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const n = await clearTestData();
                    setDone(n);
                    setConfirming(false);
                    setTyped("");
                    router.refresh();
                  } finally {
                    setBusy(false);
                  }
                }}
                className="h-7 px-2.5 bg-danger text-white rounded-[4px] text-[11.5px] font-bold disabled:opacity-40"
              >
                {t("test.clearNow")}
              </button>
              <button onClick={() => { setConfirming(false); setTyped(""); }} className="p-0.5 text-muted">
                <Icon name="X" size={14} />
              </button>
            </span>
          ) : (
            <button
              onClick={() => setConfirming(true)}
              className="h-8 px-3 border border-danger-line text-danger bg-danger-soft rounded-[4px] text-[12px] font-bold flex items-center gap-1.5"
            >
              <Icon name="Trash2" size={14} /> {t("test.clear")}
            </button>
          )
        )}
      </div>

      {rows.length === 0 ? (
        <p className="text-[12.5px] text-muted py-6 text-center">{t("test.empty")}</p>
      ) : (
        <div className="bg-surface border border-line rounded-[6px] divide-y divide-line">
          {rows.map((r) => (
            <div key={r.id} className="flex items-center gap-2.5 px-3.5 py-2.5">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[9.5px] font-bold uppercase px-1.5 py-0.5 rounded-[3px] bg-warn-soft text-warn border border-warn-line">
                    {t("test.badge")}
                  </span>
                  <Link href={`/experiments/${r.id}`} className="text-[12.5px] font-semibold truncate hover:underline">
                    {r.code} — {r.title}
                  </Link>
                </div>
                <div className="text-[10.5px] text-muted mt-0.5 mono">
                  {r.createdBy} · {r.createdAt} · {r.samples} samples · {r.steps} steps · {r.runs} runs
                </div>
              </div>
              <button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await setExperimentTestMode(r.id, false);
                    router.refresh();
                  } finally {
                    setBusy(false);
                  }
                }}
                className="h-8 px-2.5 border border-line rounded-[4px] text-[11.5px] font-semibold text-charcoal hover:bg-subtle shrink-0"
                title={t("test.promoteHint")}
              >
                {t("test.promote")}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
