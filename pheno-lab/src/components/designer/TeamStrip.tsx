"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { assignExperiment } from "@/lib/actions/workflow";
import { fuzzyFilter } from "@/lib/fuzzy";
import { usePointerDrag } from "@/lib/usePointerDrag";
import { useT } from "@/lib/i18n/LanguageProvider";
import { Icon } from "@/components/ui";

export type OrgUser = { id: string; name: string; email: string; role: string };

// The experiment team as one ordered list: the FIRST person is the
// responsible technician, everyone after is a participant. Drag to reorder.
export function TeamStrip({
  ownerName,
  assigneeId,
  memberIds,
  orgUsers,
  expId,
  canEdit,
  onAddMember,
  onRemoveMember,
}: {
  ownerName: string;
  assigneeId: string | null;
  memberIds: string[];
  orgUsers: OrgUser[];
  expId: string;
  canEdit: boolean;
  onAddMember: (userId: string) => void;
  onRemoveMember: (userId: string) => void;
}) {
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [dropId, setDropId] = useState<string | null>(null);

  // Server order: assignee first, then the remaining members. Kept in local
  // state so drag/add/remove feel instant.
  const serverOrder = useMemo(() => {
    const ids = [...new Set([...(assigneeId ? [assigneeId] : []), ...memberIds])];
    return ids.filter((id) => orgUsers.some((u) => u.id === id));
  }, [assigneeId, memberIds, orgUsers]);

  const [order, setOrder] = useState<string[]>(serverOrder);
  const lastServer = useRef(serverOrder.join(","));
  useEffect(() => {
    // Adopt server changes (e.g. after a refresh) without clobbering local edits.
    const key = serverOrder.join(",");
    if (key !== lastServer.current) {
      lastServer.current = key;
      setOrder(serverOrder);
    }
  }, [serverOrder]);

  const team = order.map((id) => orgUsers.find((u) => u.id === id)).filter((u): u is OrgUser => !!u);

  // Whoever sits first is responsible for completing the work.
  const commitFirst = async (ids: string[]) => {
    const first = ids[0] ?? null;
    if (first === assigneeId) return;
    setBusy(true);
    await assignExperiment(expId, first);
    setBusy(false);
    router.refresh();
  };

  const startDrag = usePointerDrag({
    attr: "data-team-id",
    onHover: setDropId,
    onDrop: (dragged, target) => {
      const next = [...order];
      const from = next.indexOf(dragged);
      const to = next.indexOf(target);
      if (from < 0 || to < 0) return;
      next.splice(from, 1);
      next.splice(to, 0, dragged);
      setOrder(next);
      void commitFirst(next);
    },
  });

  const add = (u: OrgUser) => {
    const next = [...order, u.id];
    setOrder(next);
    setAdding(false);
    onAddMember(u.id);
    // First person added becomes the responsible technician.
    if (next.length === 1) void commitFirst(next);
  };

  const remove = (id: string) => {
    const next = order.filter((x) => x !== id);
    setOrder(next);
    onRemoveMember(id);
    if (id === assigneeId) void commitFirst(next);
  };

  return (
    <div className="bg-surface border border-line rounded-[6px] px-3.5 py-2.5 mb-3">
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
        {/* Owner */}
        <div className="min-w-32">
          <div className="text-[10px] font-bold uppercase text-muted mb-1">{t("team.owner")}</div>
          <div className="flex items-center gap-1.5">
            <Icon name="UserCog" size={13} className="text-charcoal shrink-0" />
            <span className="text-[12.5px] font-semibold">{ownerName}</span>
          </div>
        </div>

        {/* Team — first is responsible */}
        <div className="flex-1 min-w-64">
          <div className="text-[10px] font-bold uppercase text-muted mb-1">
            {t("team.team")}
            {team.length > 0 && (
              <span className="ml-1.5 font-normal normal-case text-muted/80">{t("team.firstIsResponsible")}</span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {team.map((u, i) => {
              const isLead = i === 0;
              return (
                <span
                  key={u.id}
                  data-team-id={u.id}
                  className={
                    "inline-flex items-center gap-1 rounded-[4px] border pl-1 pr-1 py-0.5 " +
                    (dropId === u.id
                      ? "border-dashed border-brand bg-brand-soft/50"
                      : isLead
                        ? "bg-brand-soft border-brand/40"
                        : "bg-subtle border-line")
                  }
                >
                  {canEdit && (
                    <span
                      onPointerDown={startDrag(u.id)}
                      className="px-0.5 cursor-grab active:cursor-grabbing [touch-action:none] text-muted/70"
                      title={t("team.dragHint")}
                    >
                      <Icon name="GripVertical" size={12} />
                    </span>
                  )}
                  <span className="mono text-[10px] text-muted">{i + 1}</span>
                  <span className={"text-[12px] " + (isLead ? "font-semibold text-brand-deep" : "")}>{u.name}</span>
                  {isLead && (
                    <span className="text-[9px] font-bold uppercase text-brand-deep/80">{t("team.lead")}</span>
                  )}
                  {canEdit && (
                    <button
                      disabled={busy}
                      onClick={() => remove(u.id)}
                      className="p-0.5 text-muted hover:text-danger"
                      title={t("team.remove")}
                    >
                      <Icon name="X" size={11} />
                    </button>
                  )}
                </span>
              );
            })}

            {canEdit && (adding || team.length === 0 ? (
              <PeopleSearch
                users={orgUsers}
                exclude={order}
                placeholder={team.length === 0 ? t("team.searchFirst") : t("team.searchMore")}
                autoFocus={adding}
                onPick={add}
                onCancel={() => setAdding(false)}
              />
            ) : (
              <button
                onClick={() => setAdding(true)}
                className="h-7 w-7 flex items-center justify-center rounded-[4px] border border-dashed border-line text-muted hover:text-brand-deep hover:border-brand/40"
                title={t("team.searchMore")}
              >
                <Icon name="Plus" size={14} />
              </button>
            ))}

            {team.length === 0 && !canEdit && (
              <span className="text-[12px] text-warn font-semibold">{t("wf.unassigned")}</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Type-ahead people picker: search by name or email, click to select.
function PeopleSearch({
  users,
  exclude,
  placeholder,
  autoFocus,
  onPick,
  onCancel,
}: {
  users: OrgUser[];
  exclude: string[];
  placeholder: string;
  autoFocus?: boolean;
  onPick: (u: OrgUser) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const matches = useMemo(() => {
    const pool = users.filter((u) => !exclude.includes(u.id));
    return fuzzyFilter(pool, query, (u) => `${u.name} ${u.email}`).slice(0, 6);
  }, [users, exclude, query]);

  return (
    <div className="relative inline-block min-w-44">
      <input
        autoFocus={autoFocus}
        className="h-7 w-full border border-line rounded-[4px] px-2 text-[12px] bg-surface"
        placeholder={placeholder}
        value={query}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => { setOpen(false); onCancel(); }, 150)}
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
      />
      {open && (
        <div className="absolute z-30 left-0 top-full mt-0.5 min-w-56 bg-surface border border-line rounded-[4px] shadow-lg max-h-52 overflow-y-auto">
          {matches.map((u) => (
            <button
              key={u.id}
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(u);
                setQuery("");
                setOpen(false);
              }}
              className="w-full text-left px-2.5 py-1.5 hover:bg-subtle border-b border-line last:border-0"
            >
              <div className="text-[12px] font-medium truncate">{u.name}</div>
              <div className="mono text-[10px] text-muted truncate">{u.email}</div>
            </button>
          ))}
          {matches.length === 0 && (
            <p className="px-2.5 py-2 text-[11px] text-muted">{t("team.noMatch")}</p>
          )}
        </div>
      )}
    </div>
  );
}
