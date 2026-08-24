"use client";

import { useState, type DragEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { StepFull, CharFull } from "@/lib/types";
import { Icon, EnvBadge } from "@/components/ui";
import { useT, useTerm } from "@/lib/i18n/LanguageProvider";

// Inline two-step delete confirmation, local to the trashcan.
export function DeleteButton({ label, onDelete }: { label: string; onDelete: () => void }) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
      <span
        className="absolute bottom-1.5 right-1.5 flex items-center gap-1 bg-surface border border-warn-line rounded-[4px] px-1.5 py-1"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="text-[10px] font-semibold text-warn">{t("card.deleteQ")}</span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setConfirming(false);
            onDelete();
          }}
          className="p-0.5 text-danger hover:bg-subtle rounded-[3px]"
          title={`Confirm delete ${label}`}
        >
          <Icon name="Check" size={12} />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setConfirming(false);
          }}
          className="p-0.5 text-muted hover:bg-subtle rounded-[3px]"
          title="Cancel"
        >
          <Icon name="X" size={12} />
        </button>
      </span>
    );
  }

  return (
    <button
      title={`Delete ${label}`}
      onClick={(e) => {
        e.stopPropagation();
        setConfirming(true);
      }}
      className="absolute bottom-2 right-2 p-1 rounded-[3px] text-muted/60 hover:text-danger hover:bg-subtle"
    >
      <Icon name="Trash2" size={13} />
    </button>
  );
}

export function StepCard({
  step,
  selected,
  canEdit,
  onSelect,
  onDelete,
  onDragStart,
  onDragOver,
  onDrop,
  onHandleDown,
  layerName,
  dropTarget,
}: {
  step: StepFull;
  layerName?: string;
  selected: boolean;
  canEdit: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onDragStart: (e: DragEvent) => void;
  onDragOver: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
  onHandleDown: (e: ReactPointerEvent) => void;
  dropTarget: boolean;
}) {
  const t = useT();
  const tt = useTerm();
  const varied = step.parameters.some((p) => p.variations.length > 0);
  const variedParams = step.parameters.filter((p) => p.variations.length > 0);

  // Cards are quiet gray by default; only steps carrying tested variables are
  // highlighted so the experiment's focus is obvious at a glance.
  const border = selected
    ? "border-2 border-brand-deep"
    : dropTarget
      ? "border-2 border-dashed border-brand"
      : varied
        ? "border-2 border-brand/70"
        : "border border-line hover:border-charcoal/40";
  const tone = varied ? "bg-surface" : "bg-subtle";
  const titleTone = varied ? "text-ink" : "text-charcoal";

  return (
    <div
      onClick={onSelect}
      draggable={canEdit}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      data-drop-step={step.id}
      className={`text-left rounded-[6px] p-3 pb-8 relative min-h-28 cursor-pointer select-none ${tone} ${border}`}
    >
      <span className="absolute top-1 right-1.5 flex items-center gap-0.5 text-[10px] font-bold text-muted mono">
        {canEdit && (
          <span
            onPointerDown={onHandleDown}
            onClick={(e) => e.stopPropagation()}
            className="p-2 -m-0.5 cursor-grab active:cursor-grabbing [touch-action:none]"
            title="Drag to reorder"
          >
            <Icon name="GripVertical" size={14} className="text-muted/70" />
          </span>
        )}
        {String(step.position + 1).padStart(2, "0")}
      </span>
      <h4 className={`text-[12px] font-bold flex items-center gap-1.5 mb-1 pr-10 ${titleTone}`}>
        <Icon name={step.process.icon} size={13} className={varied ? "shrink-0 text-brand-deep" : "shrink-0 text-muted"} />
        {tt(step.name)}
      </h4>
      {layerName && (
        <div className="mb-1.5">
          <span className="text-[9.5px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-[3px] bg-ink/5 border border-ink/15 text-charcoal inline-flex items-center gap-1">
            <Icon name="Layers" size={9} /> {layerName}
          </span>
        </div>
      )}
      <div className="text-[11px] text-charcoal mb-1.5">
        {step.equipment ? (
          <>
            {step.equipment.name.split("—")[0].trim()} ·{" "}
            <span className="mono text-muted">{step.equipment.model || step.equipment.name.split("—")[1]?.trim()}</span>
          </>
        ) : (
          <span className="text-warn">{t("card.noEquipment")}</span>
        )}
      </div>
      <div className="flex flex-wrap gap-1 mb-1.5">
        {step.parameters.slice(0, 4).map((p) => (
          <span
            key={p.id}
            className={
              "text-[10px] px-1.5 py-0.5 rounded-[3px] border " +
              (p.variations.length > 0
                ? "bg-brand-soft border-brand/50 text-brand-deep font-semibold"
                : "bg-surface border-line text-muted")
            }
          >
            {p.variations.length > 0
              ? `${p.name}: ${p.variations.map((v) => v.value).join(" / ")} ${p.unit}`.trim()
              : `${p.value} ${p.unit}`.trim() || p.name}
          </span>
        ))}
        {step.parameters.length > 4 && (
          <span className="text-[10px] px-1 py-0.5 text-muted">+{step.parameters.length - 4}</span>
        )}
      </div>
      <div className="flex flex-wrap gap-1">
        <EnvBadge name={step.environment?.name} />
        {step.recipe && (
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-[3px] bg-subtle text-charcoal border border-line inline-flex items-center gap-1">
            <Icon name="BookLock" size={9} /> {step.recipe.name}
          </span>
        )}
        {step.materials.map((m) => (
          <span
            key={m.id}
            className="text-[10px] font-semibold px-1.5 py-0.5 rounded-[3px] bg-surface text-charcoal border border-line"
          >
            {m.material.name.split("—")[0].trim()}
            {m.amount && <span className="text-muted font-normal"> · {m.amount}</span>}
          </span>
        ))}
        {varied && (
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-[3px] bg-brand-soft text-brand-deep border border-brand/50">
            {t("card.testing")} {variedParams.map((p) => tt(p.name)).join(", ")}
          </span>
        )}
      </div>
      {canEdit && <DeleteButton label={step.name} onDelete={onDelete} />}
    </div>
  );
}

export function CharCard({
  char,
  selected,
  canEdit,
  onSelect,
  onDelete,
}: {
  char: CharFull;
  selected: boolean;
  canEdit: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const tt = useTerm();
  const settings = (char.settings ?? {}) as Record<string, string>;

  return (
    <div
      onClick={onSelect}
      className={
        "text-left rounded-[6px] p-3 pb-8 relative min-h-24 cursor-pointer select-none bg-subtle " +
        (selected ? "border-2 border-brand-deep" : "border border-line hover:border-charcoal/40")
      }
    >
      <h4 className="text-[12px] font-bold flex items-center gap-1.5 mb-1.5 text-charcoal">
        <Icon name={char.process.icon} size={13} className="shrink-0 text-muted" />
        {tt(char.name)}
      </h4>
      <div className="text-[11px] text-charcoal mb-1.5">
        {char.equipment ? (
          <>
            {char.equipment.name.split("—")[0].trim()} ·{" "}
            <span className="mono text-muted">{char.equipment.model}</span>
          </>
        ) : (
          <span className="text-warn">{t("card.noInstrument")}</span>
        )}
      </div>
      <div className="flex flex-wrap gap-1 mb-1.5">
        {Object.entries(settings).slice(0, 4).map(([k, v]) => (
          <span key={k} className="text-[10px] px-1.5 py-0.5 rounded-[3px] bg-surface border border-line text-muted">
            {v}
          </span>
        ))}
      </div>
      <div className="flex flex-wrap gap-1">
        <EnvBadge name={char.environment?.name} />
        <span className="text-[10px] px-1.5 py-0.5 rounded-[3px] bg-surface border border-line text-muted">
          {char.sampleScope === "all" ? t("card.allSamples") : char.sampleScope === "per-group" ? t("card.perGroup") : char.sampleScope}
        </span>
      </div>
      {canEdit && <DeleteButton label={char.name} onDelete={onDelete} />}
    </div>
  );
}
