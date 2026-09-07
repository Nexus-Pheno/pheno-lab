"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n/LanguageProvider";
import { Icon } from "@/components/ui";
import { decideAccessRequest } from "@/lib/actions/experiments";

/**
 * Pending access requests, shown above the designer to whoever can manage
 * the experiment. Approving adds the requester as a member on the spot.
 */
export function AccessRequestsBanner({
  experimentId,
  requests,
}: {
  experimentId: string;
  requests: { id: string; requester: string; message: string; createdAt: string }[];
}) {
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState<string[]>([]);

  const visible = requests.filter((r) => !hidden.includes(r.id));
  if (!visible.length) return null;

  const decide = async (id: string, approve: boolean) => {
    setBusy(true);
    await decideAccessRequest(id, approve, experimentId);
    setHidden((h) => [...h, id]);
    setBusy(false);
    router.refresh();
  };

  return (
    <div className="border-b border-warn/40 bg-warn/5 px-4 py-2 print:hidden">
      {visible.map((r) => (
        <div key={r.id} className="flex flex-wrap items-center gap-2 py-1">
          <Icon name="UserPlus" size={14} className="text-warn shrink-0" />
          <span className="text-[12.5px]">
            <b>{r.requester}</b> {t("req.asksAccess")}
            {r.message && (
              <span className="text-muted">
                {" "}
                — “{r.message.slice(0, 200)}”
              </span>
            )}
          </span>
          <span className="text-[10.5px] text-muted">{r.createdAt}</span>
          <span className="flex-1" />
          <button
            disabled={busy}
            onClick={() => decide(r.id, true)}
            className="h-7 px-2.5 text-[11.5px] font-bold text-brand-deep border border-brand/40 bg-brand-soft rounded-[4px] disabled:opacity-50"
          >
            {t("req.approve")}
          </button>
          <button
            disabled={busy}
            onClick={() => decide(r.id, false)}
            className="h-7 px-2.5 text-[11.5px] font-semibold text-danger border border-danger/40 rounded-[4px] disabled:opacity-50"
          >
            {t("req.decline")}
          </button>
        </div>
      ))}
    </div>
  );
}
