"use client";

import { useRef, useState } from "react";
import { usePointerDrag } from "@/lib/usePointerDrag";
import { useT } from "@/lib/i18n/LanguageProvider";
import { Icon } from "@/components/ui";

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
 * The substrate batch as segmented group rows — [Group A | S1 | S2 | S3] —
 * plus the standing Extras and Trash pools at the bottom. A tap toggles a
 * sample (or a whole group) in the capture scope; holding and moving picks
 * the chip up (haptic tick, floating ghost) and drops it on another zone.
 * Only the zone under the ghost highlights, never the chip's own row.
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
  const [dragging, setDragging] = useState<string | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef<string | null>(null);

  const startDrag = usePointerDrag({
    attr: "data-substrate-zone",
    onHover: setHover,
    onDragStart: (sample) => {
      draggingRef.current = sample;
      setDragging(sample);
      // A short tick tells fingers the chip is picked up (Android; iOS ignores).
      navigator.vibrate?.([60, 40, 60]);
    },
    onPoint: (x, y) => {
      const ghost = ghostRef.current;
      if (ghost) {
        ghost.style.transform = `translate(${x + 10}px, ${y - 34}px)`;
        ghost.style.opacity = "1";
      }
    },
    onDragEnd: () => {
      draggingRef.current = null;
      setDragging(null);
      if (ghostRef.current) ghostRef.current.style.opacity = "0";
    },
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
  // The chip's own zone never highlights — only a genuine drop target does.
  const dropTarget =
    dragging && hover && hover !== assignments[dragging] ? hover : null;

  /** One segment of a group row (the old Apply-to look). */
  const segment = (code: string, zone: string) => {
    const isSelected = selection?.selected.has(code) ?? false;
    const isCaptured = selection?.captured.has(code) ?? false;
    const lifted = dragging === code;
    return (
      <span
        key={code}
        data-substrate-zone={zone}
        onPointerDown={disabled ? undefined : startDrag(code)}
        className={
          "mono text-[11.5px] font-semibold px-2 flex items-center gap-0.5 select-none transition-opacity " +
          (disabled ? "opacity-60 " : "cursor-grab [touch-action:pan-y] active:cursor-grabbing ") +
          (lifted ? "opacity-30 " : "") +
          (isSelected
            ? "bg-ink text-white"
            : isCaptured
              ? "bg-brand-soft text-brand-deep"
              : "bg-surface text-charcoal")
        }
      >
        <Icon
          name="GripVertical"
          size={9}
          className={isSelected ? "text-white/50" : "text-line"}
        />
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

  /** Loose chip for the Extras / Trash pools. */
  const poolChip = (code: string, zone: string) => {
    const lifted = dragging === code;
    return (
      <span
        key={code}
        data-substrate-zone={zone}
        onPointerDown={disabled ? undefined : startDrag(code)}
        className={
          "mono text-[11px] font-semibold rounded-[5px] border border-line bg-surface px-1.5 py-1 select-none flex items-center gap-0.5 " +
          (disabled ? "opacity-60" : "cursor-grab [touch-action:pan-y] active:cursor-grabbing") +
          (lifted ? " opacity-30" : "")
        }
      >
        <Icon name="GripVertical" size={9} className="text-line" />
        {code}
        {simCodes[code] && (
          <span className="text-[9px] text-muted ml-0.5">{simCodes[code]}</span>
        )}
      </span>
    );
  };

  const groupRow = (label: string) => {
    const members = codes.filter((c) => assignments[c] === label);
    const active = dropTarget === label;
    const groupSelected =
      selection !== undefined &&
      members.length > 0 &&
      members.every((c) => selection.selected.has(c));
    const groupCaptured =
      selection !== undefined &&
      members.length > 0 &&
      members.every((c) => selection.captured.has(c));
    return (
      <div
        key={label}
        data-substrate-zone={label}
        className={
          "flex items-stretch h-9 rounded-[6px] border overflow-hidden divide-x transition-colors " +
          (active
            ? "border-brand ring-2 ring-brand/40 divide-line"
            : groupSelected
              ? "border-ink divide-white/20"
              : groupCaptured
                ? "border-brand/40 divide-brand/30"
                : "border-line divide-line")
        }
      >
        <button
          onClick={selection ? () => selection.onToggleGroup(label) : undefined}
          data-substrate-zone={label}
          className={
            "text-[11px] font-bold whitespace-nowrap px-2.5 flex items-center gap-1 " +
            (groupSelected
              ? "bg-ink text-white"
              : groupCaptured
                ? "bg-brand-soft text-brand-deep"
                : "bg-subtle text-charcoal")
          }
        >
          {t("plan.group")} {label}
          {groupCaptured && <span className={groupSelected ? "text-brand" : ""}>✓</span>}
        </button>
        {members.map((code) => segment(code, label))}
        {members.length === 0 && (
          <span className="text-[10px] text-muted flex items-center px-2 flex-1">
            {t("plan.dropHere")}
          </span>
        )}
      </div>
    );
  };

  const pool = (key: string, label: string, danger: boolean) => {
    const members = codes.filter((c) => assignments[c] === key);
    const active = dropTarget === key;
    return (
      <div
        key={key}
        data-substrate-zone={key}
        className={
          "flex items-start gap-2 rounded-[6px] border p-1.5 min-h-10 transition-colors " +
          (active
            ? "border-brand ring-2 ring-brand/40 bg-brand-soft"
            : danger
              ? "border-red-200 bg-red-50/50"
              : "border-dashed border-line bg-subtle")
        }
      >
        <span
          className={
            "shrink-0 text-[10.5px] font-bold pt-1.5 px-1 " +
            (danger ? "text-red-600" : "text-charcoal")
          }
        >
          {label}
          <span className="mono ml-1 font-normal text-muted">{members.length}</span>
        </span>
        <div className="flex flex-wrap gap-1 flex-1 min-w-0">
          {members.map((code) => poolChip(code, key))}
          {members.length === 0 && (
            <span className="text-[10px] text-muted pt-1.5">{t("plan.dropHere")}</span>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-1.5">
        {groups.map((g) => groupRow(g))}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
        {pool(EXTRA_GROUP, t("plan.extras"), false)}
        {pool(ERROR_GROUP, t("plan.errors"), true)}
      </div>
      {/* Ghost chip that follows the finger while dragging */}
      <div
        ref={ghostRef}
        className="fixed left-0 top-0 z-50 pointer-events-none opacity-0 mono text-[12px] font-bold bg-ink text-white rounded-[6px] px-2.5 py-1.5 shadow-lg"
        style={{ transition: "opacity 80ms" }}
      >
        {dragging}
      </div>
    </div>
  );
}
