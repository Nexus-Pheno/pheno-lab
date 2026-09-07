"use client";

import { useState, useTransition } from "react";
import { useT } from "@/lib/i18n/LanguageProvider";
import { Icon } from "@/components/ui";
import {
  createDevice,
  revokeDevice,
  type SharedDeviceRow,
} from "@/lib/actions/devices";

const ago = (iso: string | null, none: string): string => {
  if (!iso) return none;
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 1) return "<1 min";
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`;
};

export function KioskManager({ devices }: { devices: SharedDeviceRow[] }) {
  const t = useT();
  const [rows, setRows] = useState(devices);
  const [copied, setCopied] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const claimUrl = (token: string) =>
    `${window.location.origin}/kiosk/claim/${token}`;

  const add = () =>
    start(async () => {
      const row = await createDevice();
      setRows((r) => [...r, row]);
      // The freshly minted link goes straight to the clipboard — the admin's
      // whole job is handing it to a technician.
      void navigator.clipboard.writeText(claimUrl(row.setupToken!));
      setCopied(row.id);
      setTimeout(() => setCopied(null), 2000);
    });

  const toggle = (id: string) =>
    start(async () => {
      await revokeDevice(id);
      setRows((r) =>
        r.map((d) =>
          d.id === id
            ? {
                ...d,
                revoked: !d.revoked,
                currentUser: null,
                setupToken: d.revoked ? d.setupToken : null,
                claimed: d.revoked ? d.claimed : true,
              }
            : d,
        ),
      );
    });

  return (
    <div className="space-y-4">
      {/* Mint a registration link — the technician names the tablet on site. */}
      <div className="bg-surface border border-line rounded-[6px] p-4">
        <div className="flex items-center gap-3">
          <button
            onClick={add}
            disabled={pending}
            className="h-9 px-3.5 bg-ink text-white rounded-[4px] text-[12.5px] font-semibold disabled:opacity-50 flex items-center gap-1.5"
          >
            <Icon name="Plus" size={13} /> {t("kiosk.create")}
          </button>
          <p className="text-[11px] text-muted flex-1">{t("kiosk.addHint")}</p>
        </div>
      </div>

      {/* Fleet */}
      <div className="bg-surface border border-line rounded-[6px] divide-y divide-line">
        {rows.length === 0 && (
          <p className="p-4 text-[12.5px] text-muted">{t("kiosk.none")}</p>
        )}
        {rows.map((d) => (
          <div key={d.id} className="p-3.5 flex flex-wrap items-center gap-2">
            <Icon
              name="Tablet"
              size={16}
              className={d.revoked ? "text-muted" : "text-brand-deep"}
            />
            <div className="flex-1 min-w-40">
              <div
                className={
                  "text-[13px] font-bold " +
                  (d.revoked ? "text-muted line-through" : "text-ink")
                }
              >
                {d.label || t("kiosk.pendingName")}
              </div>
              <div className="text-[11px] text-muted">
                {d.revoked
                  ? t("kiosk.revoked")
                  : !d.claimed
                    ? t("kiosk.unclaimed")
                    : d.currentUser
                      ? t("kiosk.inUse", {
                          name: d.currentUser,
                          ago: ago(d.lastActivityAt, "—"),
                        })
                      : t("kiosk.idle", { ago: ago(d.lastActivityAt, "—") })}
              </div>
            </div>
            {!d.revoked && d.setupToken && (
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(claimUrl(d.setupToken!));
                  setCopied(d.id);
                  setTimeout(() => setCopied(null), 2000);
                }}
                className="h-8 px-2.5 text-[11.5px] font-bold text-brand-deep border border-brand/40 bg-brand-soft rounded-[4px] flex items-center gap-1"
              >
                <Icon name={copied === d.id ? "Check" : "Link"} size={12} />
                {copied === d.id ? t("kiosk.copied") : t("kiosk.copyLink")}
              </button>
            )}
            <button
              onClick={() => toggle(d.id)}
              disabled={pending}
              className={
                "h-8 px-2.5 text-[11.5px] font-semibold border rounded-[4px] disabled:opacity-50 " +
                (d.revoked
                  ? "text-charcoal border-line"
                  : "text-danger border-danger/40")
              }
            >
              {d.revoked ? t("kiosk.restore") : t("kiosk.revoke")}
            </button>
          </div>
        ))}
      </div>

      <p className="text-[11px] text-muted">{t("kiosk.rules")}</p>
    </div>
  );
}
