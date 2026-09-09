"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useT } from "@/lib/i18n/LanguageProvider";
import { Icon, selectCls, inputCls } from "@/components/ui";
import { METRICS } from "@/lib/analysis-metrics";

// The scope picker: which slice of the lab's history the comparison runs over.
// Every control writes to the URL, so an analysis can be linked and shared —
// which is the point of making it org-wide in the first place.
export function ScopeBar({
  projects,
  conditions,
}: {
  projects: { id: string; name: string }[];
  conditions: {
    key: string;
    label: string;
    process: string;
    unit: string;
    experiments: number;
  }[];
}) {
  const t = useT();
  const router = useRouter();
  const params = useSearchParams();

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    router.push(`/analysis?${next.toString()}`);
  };
  const value = (key: string) => params.get(key) ?? "";

  return (
    <div className="bg-surface border border-line rounded-[6px] p-3 flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-1">
        <span className="text-[10px] font-bold uppercase text-muted">
          {t("an.condition")}
        </span>
        <select
          className={selectCls + " min-w-56"}
          value={value("condition")}
          onChange={(e) => set("condition", e.target.value)}
        >
          <option value="">{t("an.pickCondition")}</option>
          {conditions.map((c) => (
            <option key={c.key} value={c.key}>
              {c.process ? `${c.process} · ` : ""}
              {c.label}
              {c.unit ? ` (${c.unit})` : ""} — {c.experiments}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[10px] font-bold uppercase text-muted">
          {t("an.metric")}
        </span>
        <select
          className={selectCls}
          value={value("metric") || "pce"}
          onChange={(e) => set("metric", e.target.value)}
        >
          {METRICS.map((m) => (
            <option key={m} value={m}>
              {m.toUpperCase()}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[10px] font-bold uppercase text-muted">
          {t("dash.project")}
        </span>
        <select
          className={selectCls}
          value={value("projectId")}
          onChange={(e) => set("projectId", e.target.value)}
        >
          <option value="">{t("dash.allProjects")}</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[10px] font-bold uppercase text-muted">
          {t("an.from")}
        </span>
        <input
          type="date"
          className={inputCls + " w-36"}
          value={value("from")}
          onChange={(e) => set("from", e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[10px] font-bold uppercase text-muted">
          {t("an.to")}
        </span>
        <input
          type="date"
          className={inputCls + " w-36"}
          value={value("to")}
          onChange={(e) => set("to", e.target.value)}
        />
      </label>

      <label className="flex flex-col gap-1 flex-1 min-w-40">
        <span className="text-[10px] font-bold uppercase text-muted">
          {t("an.filter")}
        </span>
        <input
          className={inputCls}
          placeholder={t("an.filterHint")}
          defaultValue={value("q")}
          onKeyDown={(e) => {
            if (e.key === "Enter")
              set("q", (e.target as HTMLInputElement).value);
          }}
        />
      </label>

      {[...params.keys()].length > 0 && (
        <button
          onClick={() => router.push("/analysis")}
          className="h-[30px] px-2.5 rounded-[4px] border border-line text-[11.5px] font-semibold text-muted hover:bg-subtle flex items-center gap-1"
        >
          <Icon name="X" size={12} /> {t("an.reset")}
        </button>
      )}
    </div>
  );
}
