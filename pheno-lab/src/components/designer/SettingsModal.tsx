"use client";

import { useState } from "react";
import type { ExperimentStatus } from "@prisma/client";
import type { ExperimentFull } from "@/lib/types";
import { STATUS_META } from "@/lib/library";
import { useT } from "@/lib/i18n/LanguageProvider";
import { Icon, FieldLabel, inputCls, selectCls } from "@/components/ui";

export function SettingsModal({
  exp,
  orgUsers,
  canEdit,
  canManageMembers,
  onClose,
  onMeta,
  onAddMember,
  onRemoveMember,
  onDelete,
}: {
  exp: ExperimentFull;
  orgUsers: { id: string; name: string; email: string; role: string }[];
  canEdit: boolean;
  canManageMembers: boolean;
  onClose: () => void;
  onMeta: (patch: { title?: string; campaign?: string; status?: ExperimentStatus }) => void;
  onAddMember: (userId: string) => void;
  onRemoveMember: (userId: string) => void;
  onDelete: () => void;
}) {
  const t = useT();
  const [title, setTitle] = useState(exp.title);
  const [campaign, setCampaign] = useState(exp.campaign);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const memberIds = new Set(exp.members.map((m) => m.userId));
  const addable = orgUsers.filter((u) => !memberIds.has(u.id));

  return (
    <div
      className="fixed inset-0 z-50 bg-ink/30 flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-surface rounded-[8px] border border-line shadow-lg flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-line">
          <Icon name="Settings2" size={15} className="text-charcoal" />
          <h3 className="text-[14px] font-bold flex-1">{t("set.title")}</h3>
          <span className="mono text-[11px] text-muted">{exp.code}</span>
          <button onClick={onClose} className="p-1 rounded-[3px] text-muted hover:bg-subtle" title="Close">
            <Icon name="X" size={15} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3.5 space-y-4">
          <div>
            <FieldLabel>{t("set.expTitle")}</FieldLabel>
            <input
              className={inputCls}
              value={title}
              disabled={!canEdit}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => title !== exp.title && onMeta({ title })}
            />
          </div>

          <div>
            <FieldLabel>{t("set.campaign")}</FieldLabel>
            <input
              className={inputCls}
              value={campaign}
              disabled={!canEdit}
              onChange={(e) => setCampaign(e.target.value)}
              onBlur={() => campaign !== exp.campaign && onMeta({ campaign })}
            />
            <p className="text-[10px] text-muted mt-1">{t("set.campaignHint")}</p>
          </div>

          <div>
            <FieldLabel>{t("set.status")}</FieldLabel>
            <select
              className={selectCls}
              disabled={!canEdit}
              value={exp.status}
              onChange={(e) => onMeta({ status: e.target.value as ExperimentStatus })}
            >
              {Object.keys(STATUS_META).map((value) => (
                <option key={value} value={value}>
                  {t(`status.${value}` as "status.DRAFT")}
                </option>
              ))}
            </select>
            <p className="text-[10px] text-muted mt-1">
              {t("set.statusHint")}
            </p>
          </div>

          <div>
            <FieldLabel>{t("set.participants")}</FieldLabel>
            <div className="border border-line rounded-[4px] divide-y divide-line">
              <div className="flex items-center gap-2 px-2.5 py-1.5 bg-subtle">
                <Icon name="UserCog" size={13} className="text-charcoal" />
                <span className="text-[12px] font-semibold flex-1">{exp.createdBy.name}</span>
                <span className="text-[10px] text-muted">{t("set.creator")}</span>
              </div>
              {exp.members.map((m) => (
                <div key={m.userId} className="flex items-center gap-2 px-2.5 py-1.5">
                  <Icon name="User" size={13} className="text-muted" />
                  <span className="text-[12px] flex-1">
                    {m.user.name}
                    <span className="text-muted"> · {t(`role.${m.user.role}` as "role.ADMIN")}</span>
                  </span>
                  {canManageMembers && m.userId !== exp.createdById && (
                    <button
                      onClick={() => onRemoveMember(m.userId)}
                      className="text-[10px] font-semibold text-muted hover:text-danger"
                    >
                      {t("set.remove")}
                    </button>
                  )}
                </div>
              ))}
            </div>
            {canManageMembers && addable.length > 0 && (
              <select
                className={selectCls + " mt-1.5"}
                value=""
                onChange={(e) => e.target.value && onAddMember(e.target.value)}
              >
                <option value="">{t("set.grant")}</option>
                {addable.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} · {t(`role.${u.role}` as "role.ADMIN")} · {u.email}
                  </option>
                ))}
              </select>
            )}
          </div>

          {exp.labels.length > 0 && (
            <div>
              <FieldLabel>{t("set.autoLabels")}</FieldLabel>
              <div className="flex flex-wrap gap-1">
                {exp.labels.map((l) => (
                  <span key={l.labelId} className="text-[10px] px-1.5 py-0.5 bg-subtle border border-line rounded-[3px] text-charcoal">
                    {l.label.name}
                  </span>
                ))}
              </div>
              <p className="text-[10px] text-muted mt-1">
                {t("set.autoLabelsHint")}
              </p>
            </div>
          )}
        </div>

        {canEdit && (
          <div className="px-4 py-3 border-t border-line flex justify-end">
            {confirmingDelete ? (
              <span className="flex items-center gap-2 text-[12px]">
                <span className="font-semibold text-warn">{t("set.deleteQ")}</span>
                <button onClick={onDelete} className="text-danger font-bold hover:underline">{t("set.deleteYes")}</button>
                <button onClick={() => setConfirmingDelete(false)} className="text-muted hover:underline">{t("set.deleteNo")}</button>
              </span>
            ) : (
              <button
                onClick={() => setConfirmingDelete(true)}
                className="text-[11px] font-semibold text-muted hover:text-danger"
              >
                {t("set.delete")}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
