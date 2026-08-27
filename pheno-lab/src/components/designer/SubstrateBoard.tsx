"use client";

import { useState } from "react";
import { usePointerDrag } from "@/lib/usePointerDrag";
import { useT } from "@/lib/i18n/LanguageProvider";
import { Icon } from "@/components/ui";

export const EXTRA_GROUP = "EXTRA";
export const ERROR_GROUP = "ERROR";

/**
 * The substrate batch as draggable chips (S1…Sn) bucketed into variable
 * groups plus the standing Extras and Error pools. Works with touch via the
 * pointer-drag hook; a chip dropped on a zone moves there.
 */
export function SubstrateBoard({
  groups,
  assignments,
  simCodes = {},
  disabled = false,
  onMove,
}: {
  /** Variable group labels, e.g. ["A", "B"]. Extras/Error zones are implied. */
  groups: string[];
  /** sample code (S1) → group label, EXTRA or ERROR */
  assignments: Record<string, string>;
  /** sample code → solar-simulator code, shown small when present */
  simCodes?: Record<string, string | null>;
  disabled?: boolean;
  onMove: (sample: string, group: string) => void;
}) {
  const t = useT();
  const [hover, setHover] = useState<string | null>(null);

  const startDrag = usePointerDrag({
    attr: "data-substrate-zone",
    onHover: setHover,
    onDrop: (sample, zone) => {
      setHover(null);
      if (assignments[sample] !== zone) onMove(sample, zone);
    },
  });

  const zones: { key: string; label: string; tone: "brand" | "muted" | "danger" }[] = [
    ...groups.map((g) => ({ key: g, label: `${t("plan.group")} ${g}`, tone: "brand" as const })),
    { key: EXTRA_GROUP, label: t("plan.extras"), tone: "muted" },
    { key: ERROR_GROUP, label: t("plan.errors"), tone: "danger" },
  ];
  const codes = Object.keys(assignments).sort(
    (a, b) => Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, "")),
  );

  return (
    <div className="space-y-1.5">
      {zones.map((zone) => {
        const members = codes.filter((c) => assignments[c] === zone.key);
        const active = hover === zone.key;
        return (
          <div
            key={zone.key}
            data-substrate-zone={zone.key}
            className={
              "flex items-start gap-2 rounded-[6px] border p-1.5 min-h-10 transition-colors " +
              (active
                ? "border-brand bg-brand-soft"
                : zone.tone === "danger"
                  ? "border-red-200 bg-red-50/50"
                  : zone.tone === "muted"
                    ? "border-dashed border-line bg-subtle"
                    : "border-line bg-surface")
            }
          >
            <span
              className={
                "shrink-0 w-20 text-[10.5px] font-bold pt-1 " +
                (zone.tone === "danger" ? "text-red-600" : "text-charcoal")
              }
            >
              {zone.label}
              <span className="mono ml-1 font-normal text-muted">{members.length}</span>
            </span>
            <div className="flex flex-wrap gap-1 flex-1 min-w-0">
              {members.map((code) => (
                <span
                  key={code}
                  data-substrate-zone={zone.key}
                  onPointerDown={disabled ? undefined : startDrag(code)}
                  className={
                    "mono text-[11px] font-semibold rounded-[4px] border border-line bg-surface px-1.5 py-1 select-none " +
                    (disabled ? "opacity-60" : "cursor-grab touch-none active:cursor-grabbing")
                  }
                >
                  <Icon name="GripVertical" size={9} className="inline mr-0.5 text-muted" />
                  {code}
                  {simCodes[code] && (
                    <span className="ml-1 text-[9px] text-muted">{simCodes[code]}</span>
                  )}
                </span>
              ))}
              {members.length === 0 && (
                <span className="text-[10px] text-muted pt-1.5">{t("plan.dropHere")}</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
