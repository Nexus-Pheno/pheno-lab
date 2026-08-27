"use client";

import { useState } from "react";
import { usePointerDrag } from "@/lib/usePointerDrag";
import { useT } from "@/lib/i18n/LanguageProvider";

export const EXTRA_GROUP = "EXTRA";
export const ERROR_GROUP = "ERROR";

export type BoardSelection = {
  /** Selected sample codes (capture scope). */
  selected: Set<string>;
  /** Captured sample codes — rendered green with a check. */
  captured: Set<string>;
  onToggleSample: (code: string) => void;
  onToggleGroup: (label: string) => void;
};

/**
 * The substrate batch as chips (S1…Sn) bucketed into variable groups plus
 * the standing Extras and Trash pools at the bottom. Chips drag between
 * zones (touch-capable); with `selection` set, a plain tap toggles the
 * sample in the capture scope and tapping a group label toggles the group —
 * one control for both choosing what to record and reshuffling substrates.
 */
export function SubstrateBoard({
  groups,
  assignments,
  simCodes = {},
  disabled = false,
  selection,
  onMove,
}: {
  /** Variable group labels, e.g. ["A", "B"]. Extras/Trash zones are implied. */
  groups: string[];
  /** sample code (S1) → group label, EXTRA or ERROR */
  assignments: Record<string, string>;
  /** sample code → solar-simulator code, shown small when present */
  simCodes?: Record<string, string | null>;
  disabled?: boolean;
  selection?: BoardSelection;
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
    onTap: selection
      ? (sample) => {
          // Extras/Trash hold no plan values, so they are drag-only.
          const zone = assignments[sample];
          if (zone !== EXTRA_GROUP && zone !== ERROR_GROUP) {
            selection.onToggleSample(sample);
          }
        }
      : undefined,
  });

  const codes = Object.keys(assignments).sort(
    (a, b) => Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, "")),
  );

  const chip = (code: string, zone: string) => {
    const isSelected = selection?.selected.has(code) ?? false;
    const isCaptured = selection?.captured.has(code) ?? false;
    return (
      <span
        key={code}
        data-substrate-zone={zone}
        onPointerDown={disabled ? undefined : startDrag(code)}
        className={
          "mono text-[11px] font-semibold rounded-[5px] border px-2 py-1.5 select-none flex items-center gap-1 " +
          (disabled ? "opacity-60 " : "cursor-grab touch-none active:cursor-grabbing ") +
          (isSelected
            ? "bg-ink text-white border-ink"
            : isCaptured
              ? "bg-brand-soft text-brand-deep border-brand/40"
              : "bg-surface text-charcoal border-line")
        }
      >
        {code}
        {isCaptured && <span className={isSelected ? "text-brand" : ""}>✓</span>}
        {simCodes[code] && (
          <span className={"text-[9px] " + (isSelected ? "text-white/60" : "text-muted")}>
            {simCodes[code]}
          </span>
        )}
      </span>
    );
  };

  const zoneBox = (
    key: string,
    label: string,
    tone: "brand" | "muted" | "danger",
  ) => {
    const members = codes.filter((c) => assignments[c] === key);
    const active = hover === key;
    const isGroup = tone === "brand";
    const groupSelected =
      isGroup &&
      selection !== undefined &&
      members.length > 0 &&
      members.every((c) => selection.selected.has(c));
    const groupCaptured =
      isGroup &&
      selection !== undefined &&
      members.length > 0 &&
      members.every((c) => selection.captured.has(c));
    return (
      <div
        key={key}
        data-substrate-zone={key}
        className={
          "flex items-start gap-2 rounded-[6px] border p-1.5 min-h-11 transition-colors " +
          (active
            ? "border-brand bg-brand-soft"
            : tone === "danger"
              ? "border-red-200 bg-red-50/50"
              : tone === "muted"
                ? "border-dashed border-line bg-subtle"
                : "border-line bg-surface")
        }
      >
        {isGroup && selection ? (
          <button
            onClick={() => selection.onToggleGroup(key)}
            className={
              "shrink-0 min-w-16 text-[11px] font-bold rounded-[4px] px-2 py-1.5 text-left " +
              (groupSelected
                ? "bg-ink text-white"
                : groupCaptured
                  ? "bg-brand-soft text-brand-deep"
                  : "bg-subtle text-charcoal")
            }
          >
            {label}
            <span className={"mono ml-1 font-normal " + (groupSelected ? "text-white/60" : "text-muted")}>
              {members.length}
            </span>
            {groupCaptured && " ✓"}
          </button>
        ) : (
          <span
            className={
              "shrink-0 min-w-16 text-[10.5px] font-bold pt-1.5 px-1 " +
              (tone === "danger" ? "text-red-600" : "text-charcoal")
            }
          >
            {label}
            <span className="mono ml-1 font-normal text-muted">{members.length}</span>
          </span>
        )}
        <div className="flex flex-wrap gap-1 flex-1 min-w-0">
          {members.map((code) => chip(code, key))}
          {members.length === 0 && (
            <span className="text-[10px] text-muted pt-2">{t("plan.dropHere")}</span>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-1.5">
      {groups.map((g) => zoneBox(g, `${t("plan.group")} ${g}`, "brand"))}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
        {zoneBox(EXTRA_GROUP, t("plan.extras"), "muted")}
        {zoneBox(ERROR_GROUP, t("plan.errors"), "danger")}
      </div>
    </div>
  );
}
