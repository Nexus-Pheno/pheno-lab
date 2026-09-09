"use client";

import { useState, useTransition } from "react";
import { useT } from "@/lib/i18n/LanguageProvider";
import { Icon, inputCls } from "@/components/ui";
import {
  createProject,
  renameProject,
  setProjectActive,
} from "@/lib/actions/experiments";
import type { ProjectRow } from "@/modules/experiments/project-service";

// 课题组 (2026-09-09): the lab's research directions, curated here and picked
// in every experiment's settings. Deactivating retires a finished project from
// the pickers without disturbing the experiments already filed under it.
export function ProjectsSection({
  projects: initial,
  canManage,
}: {
  projects: ProjectRow[];
  canManage: boolean;
}) {
  const t = useT();
  const [projects, setProjects] = useState(initial);
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, startTransition] = useTransition();

  const refresh = (next: ProjectRow[]) =>
    setProjects(
      [...next].sort(
        (a, b) =>
          Number(b.active) - Number(a.active) || a.name.localeCompare(b.name),
      ),
    );

  const add = () => {
    const value = name.trim();
    if (!value) return;
    startTransition(async () => {
      const created = await createProject(value);
      setName("");
      if (!projects.some((p) => p.id === created.id))
        refresh([
          ...projects,
          { ...created, active: true, experimentCount: 0 },
        ]);
      else
        refresh(
          projects.map((p) =>
            p.id === created.id ? { ...p, active: true } : p,
          ),
        );
    });
  };

  const rename = (id: string) => {
    const value = draft.trim();
    setEditing(null);
    if (!value) return;
    startTransition(async () => {
      await renameProject(id, value);
      refresh(projects.map((p) => (p.id === id ? { ...p, name: value } : p)));
    });
  };

  const toggle = (id: string, active: boolean) => {
    startTransition(async () => {
      await setProjectActive(id, active);
      refresh(projects.map((p) => (p.id === id ? { ...p, active } : p)));
    });
  };

  return (
    <section>
      <div className="flex items-baseline gap-2 mb-1">
        <h2 className="text-[15px] font-bold">{t("proj.title")}</h2>
        <span className="text-[11px] text-muted mono">{projects.length}</span>
      </div>
      <p className="text-[11px] text-muted mb-2.5 max-w-2xl">
        {t("proj.hint")}
      </p>

      <div className="bg-surface border border-line rounded-[6px] divide-y divide-line">
        {projects.length === 0 && (
          <p className="px-3 py-3 text-[12px] text-muted">{t("proj.empty")}</p>
        )}
        {projects.map((p) => (
          <div key={p.id} className="flex items-center gap-2 px-3 py-2">
            {editing === p.id ? (
              <>
                <input
                  className={inputCls}
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") rename(p.id);
                    if (e.key === "Escape") setEditing(null);
                  }}
                />
                <button
                  onClick={() => rename(p.id)}
                  className="shrink-0 text-[11px] font-bold text-brand-deep"
                >
                  {t("proj.save")}
                </button>
                <button
                  onClick={() => setEditing(null)}
                  className="shrink-0 text-[11px] font-semibold text-muted"
                >
                  {t("proj.cancel")}
                </button>
              </>
            ) : (
              <>
                <span
                  className={
                    "text-[13px] font-semibold flex-1 " +
                    (p.active ? "" : "text-muted line-through")
                  }
                >
                  {p.name}
                </span>
                <span className="text-[10.5px] text-muted mono shrink-0">
                  {p.experimentCount} {t("proj.experiments")}
                </span>
                {canManage && (
                  <>
                    <button
                      onClick={() => {
                        setEditing(p.id);
                        setDraft(p.name);
                      }}
                      disabled={pending}
                      title={t("proj.rename")}
                      className="shrink-0 p-1 rounded-[3px] text-muted hover:text-ink hover:bg-subtle"
                    >
                      <Icon name="Pencil" size={13} />
                    </button>
                    <button
                      onClick={() => toggle(p.id, !p.active)}
                      disabled={pending}
                      className="shrink-0 text-[11px] font-semibold text-muted hover:text-charcoal"
                    >
                      {t(p.active ? "proj.deactivate" : "proj.activate")}
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        ))}
      </div>

      {canManage && (
        <div className="flex items-center gap-1.5 mt-2">
          <input
            className={inputCls + " max-w-xs"}
            placeholder={t("proj.name")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
          <button
            onClick={add}
            disabled={pending || !name.trim()}
            className="shrink-0 h-[30px] px-3 rounded-[4px] bg-brand text-[#243000] text-[11.5px] font-bold disabled:opacity-50"
          >
            {t("proj.add")}
          </button>
        </div>
      )}
    </section>
  );
}
