"use client";

import { useEffect, useId, useRef } from "react";
import type {
  PlanParameterValues,
  TestPlanConfirmation,
} from "@/modules/experiments/plan-routing";
import { useT } from "@/lib/i18n/LanguageProvider";

export function TestPlanOverwriteDialog({
  preview,
  layers,
  busy,
  refreshed,
  onCancel,
  onConfirm,
}: {
  preview: TestPlanConfirmation;
  layers: { code: string; name: string }[];
  busy: boolean;
  refreshed: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  const renderValues = (value: PlanParameterValues | null) =>
    value ? (
      <div className="space-y-1 text-[12px] whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
        <p>
          {t("plan.overwrite.base")}:{" "}
          <span className="mono">
            {value.value || "—"} {value.unit}
          </span>
        </p>
        {value.groups.map((group) => (
          <p key={group.group}>
            <span className="font-semibold">{group.group}</span>:{" "}
            <span className="mono">{group.value || "—"}</span>
          </p>
        ))}
      </div>
    ) : (
      <p className="text-[12px]">{t("plan.overwrite.remove")}</p>
    );
  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      className="m-auto w-[calc(100%_-_2rem)] max-w-3xl max-h-[85dvh] overflow-y-auto rounded-lg border border-line bg-white p-0 text-ink shadow-xl backdrop:bg-black/40"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <div className="p-4 sm:p-6">
        <h2 id={titleId} className="font-bold text-lg">
          {t("plan.overwrite.title")}
        </h2>
        <p className="mt-2 text-sm text-muted">{t("plan.overwrite.hint")}</p>
        {refreshed && (
          <p role="status" className="mt-2 text-sm text-danger">
            {t("plan.overwrite.refreshed")}
          </p>
        )}
        <ul className="mt-4 space-y-4">
          {preview.changes.map((change) => (
            <li
              key={change.parameterId}
              className="rounded border border-line p-3 min-w-0 [overflow-wrap:anywhere]"
            >
              <h3 className="font-semibold text-sm">
                {change.stepName} · {change.parameter}
              </h3>
              <p className="text-xs text-muted mt-1">
                {change.processName} ·{" "}
                {change.equipmentName || t("plan.overwrite.unassigned")} ·{" "}
                {layers.find((layer) => layer.code === change.layer)?.name ||
                  change.layer ||
                  t("plan.overwrite.unassigned")}
              </p>
              <div className="grid sm:grid-cols-2 gap-3 mt-3">
                <div className="min-w-0">
                  <h4 className="text-xs font-bold mb-1">
                    {t("plan.overwrite.before")}
                  </h4>
                  {renderValues(change.before)}
                </div>
                <div className="min-w-0">
                  <h4 className="text-xs font-bold mb-1">
                    {t("plan.overwrite.after")}
                  </h4>
                  {renderValues(change.after)}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
      <div className="sticky bottom-0 bg-white border-t border-line p-4 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          autoFocus
          disabled={busy}
          onClick={onCancel}
          className="border border-line rounded px-3 py-2 text-sm disabled:opacity-50"
        >
          {t("plan.overwrite.cancel")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onConfirm}
          className="bg-ink text-white rounded px-3 py-2 text-sm disabled:opacity-50"
        >
          {t("plan.overwrite.confirm")}
        </button>
      </div>
    </dialog>
  );
}
