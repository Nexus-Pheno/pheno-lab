"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createOrgInvite, approveOrganization, rejectOrganization, saveOrgDomains } from "@/lib/actions/orgs";
import { useT } from "@/lib/i18n/LanguageProvider";
import { Icon, FieldLabel, inputCls } from "@/components/ui";

type OrgRow = {
  id: string;
  orgNumber: number;
  name: string;
  domains: string;
  status: string;
  userCount: number;
  adminName: string;
  adminEmail: string;
};

export function OrgAdmin({ orgs }: { orgs: OrgRow[] }) {
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [inviteUrl, setInviteUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const [editingDomains, setEditingDomains] = useState<string | null>(null);
  const [domainsDraft, setDomainsDraft] = useState("");
  const [confirmReject, setConfirmReject] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      {/* Organization list */}
      <section className="bg-surface border border-line rounded-[6px] overflow-x-auto">
        <table className="w-full min-w-[700px] text-[12.5px]">
          <thead>
            <tr className="text-left text-[10px] uppercase text-muted border-b border-line">
              <th className="px-3.5 py-2 font-bold">#</th>
              <th className="px-3.5 py-2 font-bold">{t("orgs.name")}</th>
              <th className="px-3.5 py-2 font-bold">{t("orgs.admin")}</th>
              <th className="px-3.5 py-2 font-bold">{t("orgs.domains")}</th>
              <th className="px-3.5 py-2 font-bold text-right">{t("orgs.members")}</th>
              <th className="px-3.5 py-2 font-bold">{t("orgs.status")}</th>
              <th className="px-3.5 py-2" />
            </tr>
          </thead>
          <tbody>
            {orgs.map((o) => (
              <tr key={o.id} className="border-b border-line last:border-0">
                <td className="px-3.5 py-2.5 mono">{String(o.orgNumber).padStart(3, "0")}</td>
                <td className="px-3.5 py-2.5 font-medium">{o.name}</td>
                <td className="px-3.5 py-2.5">
                  {o.adminName}
                  {o.adminEmail && <div className="mono text-[10.5px] text-muted">{o.adminEmail}</div>}
                </td>
                <td className="px-3.5 py-2.5">
                  {editingDomains === o.id ? (
                    <span className="flex items-center gap-1.5">
                      <input
                        className="border border-line rounded-[3px] px-2 py-1 text-[11.5px] mono w-48"
                        value={domainsDraft}
                        onChange={(e) => setDomainsDraft(e.target.value)}
                        autoFocus
                      />
                      <button
                        disabled={busy}
                        onClick={async () => {
                          setBusy(true);
                          await saveOrgDomains(o.id, domainsDraft);
                          setBusy(false);
                          setEditingDomains(null);
                          router.refresh();
                        }}
                        className="p-1 text-brand-deep"
                      >
                        <Icon name="Check" size={13} />
                      </button>
                      <button onClick={() => setEditingDomains(null)} className="p-1 text-muted">
                        <Icon name="X" size={13} />
                      </button>
                    </span>
                  ) : (
                    <button
                      onClick={() => { setEditingDomains(o.id); setDomainsDraft(o.domains); }}
                      className="mono text-[11.5px] text-charcoal hover:underline text-left"
                      title={t("orgs.editDomains")}
                    >
                      {o.domains || "—"}
                    </button>
                  )}
                </td>
                <td className="px-3.5 py-2.5 mono text-right">{o.userCount}</td>
                <td className="px-3.5 py-2.5">
                  <span
                    className={
                      "text-[10px] font-semibold px-1.5 py-0.5 rounded-[3px] border " +
                      (o.status === "ACTIVE"
                        ? "bg-brand-soft text-brand-deep border-brand/40"
                        : "bg-warn-soft text-warn border-warn-line")
                    }
                  >
                    {t(o.status === "ACTIVE" ? "orgs.active" : "orgs.pending")}
                  </span>
                </td>
                <td className="px-3.5 py-2.5 text-right whitespace-nowrap">
                  {o.status === "PENDING" && (
                    <span className="flex items-center gap-1.5 justify-end">
                      <button
                        disabled={busy}
                        onClick={async () => {
                          setBusy(true);
                          await approveOrganization(o.id);
                          setBusy(false);
                          router.refresh();
                        }}
                        className="text-[11.5px] font-bold bg-brand text-[#243000] rounded-[4px] px-2.5 py-1"
                      >
                        {t("orgs.approve")}
                      </button>
                      {confirmReject === o.id ? (
                        <span className="flex items-center gap-1 bg-warn-soft border border-warn-line rounded-[4px] px-1.5 py-0.5">
                          <span className="text-[10px] font-semibold text-warn">{t("orgs.rejectQ")}</span>
                          <button
                            disabled={busy}
                            onClick={async () => {
                              setBusy(true);
                              await rejectOrganization(o.id);
                              setBusy(false);
                              setConfirmReject(null);
                              router.refresh();
                            }}
                            className="p-0.5 text-danger"
                          >
                            <Icon name="Check" size={12} />
                          </button>
                          <button onClick={() => setConfirmReject(null)} className="p-0.5 text-muted">
                            <Icon name="X" size={12} />
                          </button>
                        </span>
                      ) : (
                        <button
                          onClick={() => setConfirmReject(o.id)}
                          className="text-[11.5px] font-semibold text-muted hover:text-danger px-1.5 py-1"
                        >
                          {t("orgs.reject")}
                        </button>
                      )}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* Invite an organization */}
      <section className="bg-surface border border-line rounded-[6px] p-4">
        <h2 className="text-[13px] font-bold flex items-center gap-1.5 mb-1">
          <Icon name="Building2" size={14} className="text-charcoal" /> {t("orgs.invite")}
        </h2>
        <p className="text-[11px] text-muted mb-3">{t("orgs.inviteHint")}</p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const { token } = await createOrgInvite();
              setInviteUrl(`${window.location.origin}/onboard?token=${token}`);
              setCopied(false);
              setBusy(false);
            }}
            className="h-9 bg-ink text-white rounded-[4px] px-4 text-[12.5px] font-semibold disabled:opacity-50"
          >
            {t("orgs.generateLink")}
          </button>
          {inviteUrl && (
            <>
              <input readOnly className={inputCls + " mono flex-1 min-w-60"} value={inviteUrl} onFocus={(e) => e.target.select()} />
              <button
                onClick={async () => {
                  await navigator.clipboard.writeText(inviteUrl);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
                className="h-9 px-3 border border-line rounded-[4px] text-[12px] font-semibold text-charcoal hover:bg-subtle flex items-center gap-1.5"
              >
                <Icon name="Copy" size={13} /> {t(copied ? "orgs.copied" : "orgs.copy")}
              </button>
            </>
          )}
        </div>
        {inviteUrl && <p className="text-[10.5px] text-muted mt-2">{t("orgs.linkTtl")}</p>}
      </section>
    </div>
  );
}
