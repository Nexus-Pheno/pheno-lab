"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n/LanguageProvider";
import { Icon } from "@/components/ui";
import { requestExperimentAccess } from "@/lib/actions/experiments";

/**
 * What a technician sees when they click a colleague's experiment: the card's
 * metadata and a knock-on-the-door form. Approval (by the owner or any
 * manager) adds them as a member, and the same URL opens normally.
 */
export function RequestAccess({
  experiment,
}: {
  experiment: {
    id: string;
    code: string;
    title: string;
    owner: string;
    createdAt: string;
    myRequest: { status: string; createdAt: string } | null;
  };
}) {
  const t = useT();
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  const pending = sent || experiment.myRequest?.status === "open";
  const declined = !pending && experiment.myRequest?.status === "declined";

  return (
    <main className="h-full overflow-y-auto bg-subtle">
      <div className="max-w-md mx-auto p-6 pt-16">
        <div className="bg-surface border border-line rounded-[8px] p-6 text-center">
          <div className="w-12 h-12 rounded-full bg-brand-soft border border-brand/40 flex items-center justify-center mx-auto mb-3">
            <Icon name="Lock" size={20} className="text-brand-deep" />
          </div>
          <p className="mono text-[12px] text-muted">{experiment.code}</p>
          <h1 className="text-[16px] font-bold mb-1">{experiment.title}</h1>
          <p className="text-[12px] text-muted mb-4">
            {t("req.ownedBy", { name: experiment.owner })} ·{" "}
            {experiment.createdAt}
          </p>

          {pending ? (
            <div className="bg-brand-soft/60 border border-brand/40 rounded-[6px] px-3 py-2.5 text-[12.5px] text-brand-deep font-semibold flex items-center justify-center gap-1.5">
              <Icon name="Clock" size={14} />
              {t("req.pending", { name: experiment.owner })}
            </div>
          ) : (
            <>
              <p className="text-[12.5px] text-charcoal mb-3">
                {declined ? t("req.declined") : t("req.explain")}
              </p>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder={t("req.messagePh")}
                rows={3}
                className="w-full border border-line rounded-[4px] px-3 py-2 text-[13px] mb-3"
              />
              {error && (
                <p className="text-[12px] text-danger mb-2">{error}</p>
              )}
              <button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  const res = await requestExperimentAccess(
                    experiment.id,
                    message.trim(),
                  );
                  setBusy(false);
                  if (!res.ok) {
                    // Access may have been granted since the page loaded.
                    if (res.error?.includes("already have access")) {
                      router.refresh();
                      return;
                    }
                    setError(res.error ?? "");
                    return;
                  }
                  setSent(true);
                }}
                className="w-full bg-brand text-[#243000] rounded-[4px] py-2.5 text-sm font-bold disabled:opacity-50"
              >
                {busy ? t("req.sending") : t("req.send")}
              </button>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
