"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { approveExperiment, requestChanges } from "@/lib/actions/workflow";
import { useT } from "@/lib/i18n/LanguageProvider";
import { TranslatedText } from "@/components/TranslatedText";
import { Icon, FieldLabel, inputCls } from "@/components/ui";

// Manager sign-off: shown on an experiment handed back for review. Approving
// closes it and seals the evidence pack (plan + captures + results).
export function ReviewPanel({
  expId,
  code,
  assigneeName,
  submittedAt,
  submitNote,
  canApprove,
}: {
  expId: string;
  code: string;
  assigneeName: string;
  submittedAt: string;
  submitNote: string;
  canApprove: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<null | "approve" | "changes">(null);

  return (
    <div className="mb-3 bg-warn-soft border border-warn-line rounded-[6px] p-3.5">
      <div className="flex items-center gap-2 mb-1.5 flex-wrap">
        <Icon name="ClipboardCheck" size={16} className="text-warn shrink-0" />
        <span className="text-[13px] font-bold text-warn flex-1 min-w-40">
          {canApprove ? t("wf.awaiting") : t("wf.submitted")}
        </span>
        <Link
          href={`/experiments/${expId}/results`}
          className="h-8 flex items-center px-3 rounded-[4px] border border-warn-line bg-surface text-[11.5px] font-semibold text-charcoal"
        >
          {t("res.title")}
        </Link>
        <Link
          href={`/experiments/${expId}/report`}
          className="h-8 flex items-center px-3 rounded-[4px] border border-warn-line bg-surface text-[11.5px] font-semibold text-charcoal"
        >
          {t("rep.title")}
        </Link>
      </div>
      <p className="text-[11px] text-charcoal">
        <span className="mono">{code}</span> · {assigneeName} · {t("wf.submittedBy")} {submittedAt}
      </p>
      {submitNote && (
        <p className="text-[12px] text-ink bg-surface border border-warn-line rounded-[4px] px-2.5 py-1.5 mt-2">
          <TranslatedText text={submitNote} />
        </p>
      )}

      {canApprove && (
        <div className="mt-3">
          <FieldLabel>{t("wf.reviewNote")}</FieldLabel>
          <textarea
            className={inputCls + " resize-none bg-surface"}
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <p className="text-[10px] text-muted mt-1">{t("wf.reviewHint")}</p>
          <div className="flex flex-wrap items-center gap-2 mt-2.5">
            {confirm === "changes" ? (
              <span className="flex items-center gap-2 bg-surface border border-warn-line rounded-[4px] px-2.5 py-1.5">
                <span className="text-[11.5px] font-semibold text-warn">{t("wf.changesQ")}</span>
                <button
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    await requestChanges(expId, note);
                    setBusy(false);
                    router.refresh();
                  }}
                  className="p-0.5 text-danger"
                >
                  <Icon name="Check" size={13} />
                </button>
                <button onClick={() => setConfirm(null)} className="p-0.5 text-muted">
                  <Icon name="X" size={13} />
                </button>
              </span>
            ) : (
              <button
                onClick={() => setConfirm("changes")}
                className="h-9 px-3.5 border border-warn-line bg-surface rounded-[4px] text-[12px] font-semibold text-charcoal"
              >
                {t("wf.requestChanges")}
              </button>
            )}
            <span className="flex-1" />
            {confirm === "approve" ? (
              <span className="flex items-center gap-2 bg-surface border border-brand/40 rounded-[4px] px-2.5 py-1.5">
                <span className="text-[11.5px] font-semibold text-brand-deep">{t("wf.approveQ")}</span>
                <button
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    await approveExperiment(expId, note);
                    setBusy(false);
                    router.refresh();
                  }}
                  className="p-0.5 text-brand-deep"
                >
                  <Icon name="Check" size={13} />
                </button>
                <button onClick={() => setConfirm(null)} className="p-0.5 text-muted">
                  <Icon name="X" size={13} />
                </button>
              </span>
            ) : (
              <button
                onClick={() => setConfirm("approve")}
                className="h-9 px-4 bg-brand text-[#243000] rounded-[4px] text-[12.5px] font-bold flex items-center gap-1.5"
              >
                <Icon name="ShieldCheck" size={14} /> {t("wf.approve")}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
