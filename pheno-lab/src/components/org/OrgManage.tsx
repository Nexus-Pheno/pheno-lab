"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  setUserRole,
  setUserActive,
  setEmailDomains,
  createUserAccount,
  updateUserIdentity,
  approveRegistration,
  rejectRegistration,
  adminResetPassword,
} from "@/lib/actions/registration";
import { setUserPermission } from "@/lib/actions/materials";
import { renameOwnOrganization } from "@/lib/actions/orgs";
import { useT } from "@/lib/i18n/LanguageProvider";
import { Icon, FieldLabel, inputCls } from "@/components/ui";
import type { TKey } from "@/lib/i18n/dict";

export type OrgUserRow = {
  id: string;
  name: string;
  email: string;
  role: string;
  active: boolean;
  createdAt: string;
  materialAdmin: boolean;
  equipmentAdmin: boolean;
  facilityAdmin: boolean;
  recipeAccess: boolean;
  recipeSteward: boolean;
};

type PendingRow = {
  email: string;
  code: string;
  purpose: string;
  expiresAt: string;
};

// Same alphabet AddMember uses: unambiguous, easy to read over a shoulder.
function generatePassword(): string {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const arr = new Uint32Array(12);
  crypto.getRandomValues(arr);
  return [...arr].map((n) => chars[n % chars.length]).join("");
}

export type ApprovalRow = {
  id: string;
  name: string;
  handle: string;
  email: string;
  createdAt: string;
  suggestedLegacyId: string | null;
};

export type LegacyOptionRow = { id: string; name: string; experiments: number };

// The four stewardships an organization assigns, plus recipe access.
const STEWARDSHIPS = [
  {
    key: "materialAdmin",
    label: "org.stewMaterials",
    hint: "org.stewMaterialsHint",
    icon: "FlaskConical",
  },
  {
    key: "equipmentAdmin",
    label: "org.stewEquipment",
    hint: "org.stewEquipmentHint",
    icon: "Wrench",
  },
  {
    key: "facilityAdmin",
    label: "org.stewFacilities",
    hint: "org.stewFacilitiesHint",
    icon: "Building2",
  },
  {
    key: "recipeAccess",
    label: "org.stewRecipes",
    hint: "org.stewRecipesHint",
    icon: "BookLock",
  },
  {
    key: "recipeSteward",
    label: "org.recipeSteward",
    hint: "org.recipeStewardHint",
    icon: "BookOpen",
  },
] as const;

type StewardKey = (typeof STEWARDSHIPS)[number]["key"];

export function OrgManage({
  approvals,
  legacyOptions,
  sessionUid,
  orgName,
  orgNumber,
  users,
  domains: initialDomains,
  pending,
}: {
  approvals: ApprovalRow[];
  legacyOptions: LegacyOptionRow[];
  sessionUid: string;
  orgName: string;
  orgNumber: number;
  users: OrgUserRow[];
  domains: string;
  pending: PendingRow[];
}) {
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(orgName);
  const [domains, setDomains] = useState(initialDomains);
  const [savedFlash, setSavedFlash] = useState("");
  // Inline name/email editor — the lab is normalizing everyone onto English
  // names and the szpheno.com domain.
  const [editing, setEditing] = useState<{
    id: string;
    name: string;
    email: string;
  } | null>(null);
  const [editError, setEditError] = useState("");
  // Admin password reset: generated client-side, shown exactly once.
  const [pwReset, setPwReset] = useState<{
    id: string;
    password: string;
    done: boolean;
  } | null>(null);

  const flash = (msg: string) => {
    setSavedFlash(msg);
    setTimeout(() => setSavedFlash(""), 2000);
  };

  // Admins implicitly hold every stewardship.
  const holders = (key: StewardKey) =>
    users.filter((u) => u.active && (u.role === "ADMIN" || u[key]));

  const toggle = async (userId: string, key: StewardKey, value: boolean) => {
    setBusy(true);
    await setUserPermission(userId, key, value);
    setBusy(false);
    router.refresh();
  };

  return (
    <div className="space-y-6">
      {/* Organization settings */}
      <section className="bg-surface border border-line rounded-[6px] p-4 space-y-3">
        <h2 className="text-[13px] font-bold flex items-center gap-1.5">
          <Icon name="Building2" size={14} className="text-charcoal" />{" "}
          {t("org.settings")}
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2 items-end">
          <div>
            <FieldLabel>{t("org.name")}</FieldLabel>
            <input
              className={inputCls}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <button
            disabled={busy || !name.trim() || name === orgName}
            onClick={async () => {
              setBusy(true);
              await renameOwnOrganization(name);
              setBusy(false);
              flash(t("profile.saved"));
              router.refresh();
            }}
            className="h-9 bg-ink text-white rounded-[4px] px-4 text-[12.5px] font-semibold disabled:opacity-50"
          >
            {t("insp.save")}
          </button>
        </div>
        <div>
          <FieldLabel>{t("users.domains")}</FieldLabel>
          <p className="text-[11px] text-muted mb-1.5">
            {t("users.domainsHint")}
          </p>
          <div className="flex flex-wrap gap-2">
            <input
              className={inputCls + " flex-1 min-w-48 mono"}
              value={domains}
              onChange={(e) => setDomains(e.target.value)}
            />
            <button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                await setEmailDomains(domains);
                setBusy(false);
                flash(t("profile.saved"));
                router.refresh();
              }}
              className="h-9 bg-ink text-white rounded-[4px] px-4 text-[12.5px] font-semibold disabled:opacity-50"
            >
              {t("users.saveDomains")}
            </button>
          </div>
        </div>
        <p className="text-[10.5px] text-muted">
          {t("org.number")}:{" "}
          <span className="mono">{String(orgNumber).padStart(3, "0")}</span> ·{" "}
          {t("org.numberHint")}
        </p>
        {savedFlash && (
          <p className="text-[12px] text-brand-deep">{savedFlash}</p>
        )}
      </section>

      {/* Responsible people */}
      <section className="bg-surface border border-line rounded-[6px] p-4">
        <h2 className="text-[13px] font-bold flex items-center gap-1.5 mb-1">
          <Icon name="ShieldCheck" size={14} className="text-charcoal" />{" "}
          {t("org.responsible")}
        </h2>
        <p className="text-[11px] text-muted mb-3">
          {t("org.responsibleHint")}
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {STEWARDSHIPS.map((s) => {
            const list = holders(s.key);
            return (
              <div
                key={s.key}
                className="border border-line rounded-[5px] p-2.5"
              >
                <div className="flex items-center gap-1.5 mb-0.5">
                  <Icon name={s.icon} size={13} className="text-brand-deep" />
                  <span className="text-[12.5px] font-semibold">
                    {t(s.label as TKey)}
                  </span>
                </div>
                <p className="text-[10.5px] text-muted mb-1.5">
                  {t(s.hint as TKey)}
                </p>
                {list.length === 0 ? (
                  <p className="text-[11px] text-warn font-semibold">
                    {t("org.noneAssigned")}
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {list.map((u) => (
                      <span
                        key={u.id}
                        className="text-[10.5px] px-1.5 py-0.5 rounded-[3px] bg-brand-soft border border-brand/40 text-brand-deep"
                      >
                        {u.name}
                        {u.role === "ADMIN" && (
                          <span className="opacity-60">
                            {" "}
                            ({t("role.ADMIN")})
                          </span>
                        )}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Registrations waiting for the admin's go-ahead */}
      {approvals.length > 0 && (
        <section className="bg-surface border-2 border-warn/40 rounded-[6px] p-4">
          <h2 className="text-[13px] font-bold flex items-center gap-1.5 mb-1">
            <Icon name="UserCheck" size={14} className="text-warn" />{" "}
            {t("appr.title")}
            <span className="text-[11px] font-bold text-warn">
              ({approvals.length})
            </span>
          </h2>
          <p className="text-[11px] text-muted mb-3">{t("appr.hint")}</p>
          <div className="space-y-3">
            {approvals.map((a) => (
              <ApprovalCard
                key={a.id}
                approval={a}
                legacyOptions={legacyOptions}
                onDone={() => router.refresh()}
              />
            ))}
          </div>
        </section>
      )}

      {/* People & permissions matrix */}
      <section className="bg-surface border border-line rounded-[6px] overflow-x-auto">
        <table className="w-full min-w-[720px] text-[12.5px]">
          <thead>
            <tr className="text-left text-[10px] uppercase text-muted border-b border-line">
              <th className="px-3.5 py-2 font-bold">{t("users.name")}</th>
              <th className="px-3.5 py-2 font-bold">{t("users.role")}</th>
              {STEWARDSHIPS.map((s) => (
                <th key={s.key} className="px-2 py-2 font-bold text-center">
                  {t(s.label as TKey)}
                </th>
              ))}
              <th className="px-3.5 py-2 font-bold text-right">
                {t("users.active")}
              </th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr
                key={u.id}
                className={
                  "border-b border-line last:border-0 " +
                  (u.active ? "" : "opacity-45")
                }
              >
                <td className="px-3.5 py-2.5">
                  {editing?.id === u.id ? (
                    <div className="space-y-1">
                      <input
                        className="w-full h-7 border border-line rounded-[3px] px-1.5 text-[12px]"
                        value={editing.name}
                        placeholder={t("users.name")}
                        onChange={(e) =>
                          setEditing({ ...editing, name: e.target.value })
                        }
                      />
                      <input
                        className="w-full h-7 border border-line rounded-[3px] px-1.5 text-[11px] mono"
                        value={editing.email}
                        placeholder={t("users.email")}
                        onChange={(e) =>
                          setEditing({ ...editing, email: e.target.value })
                        }
                      />
                      {editError && (
                        <p className="text-[10.5px] text-danger">{editError}</p>
                      )}
                      <div className="flex gap-1">
                        <button
                          disabled={
                            busy ||
                            !editing.name.trim() ||
                            !editing.email.includes("@")
                          }
                          onClick={async () => {
                            setBusy(true);
                            setEditError("");
                            const res = await updateUserIdentity(
                              u.id,
                              editing.name,
                              editing.email,
                            );
                            setBusy(false);
                            if (!res.ok) {
                              setEditError(
                                t(
                                  res.error === "exists"
                                    ? "users.emailTaken"
                                    : "users.badInput",
                                ),
                              );
                              return;
                            }
                            setEditing(null);
                            router.refresh();
                          }}
                          className="h-6 px-2 text-[11px] font-bold text-brand-deep border border-brand/40 bg-brand-soft rounded-[3px] disabled:opacity-50"
                        >
                          {t("insp.save")}
                        </button>
                        <button
                          onClick={() => {
                            setEditing(null);
                            setEditError("");
                          }}
                          className="h-6 px-2 text-[11px] text-muted border border-line rounded-[3px]"
                        >
                          {t("users.cancel")}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="font-medium flex items-center gap-1">
                        {u.name}
                        {u.id === sessionUid && (
                          <span className="text-muted"> ({t("org.you")})</span>
                        )}
                        <button
                          disabled={busy}
                          title={t("users.editIdentity")}
                          onClick={() => {
                            setEditError("");
                            setEditing({
                              id: u.id,
                              name: u.name,
                              email: u.email,
                            });
                          }}
                          className="text-muted hover:text-brand-deep"
                        >
                          <Icon name="Pencil" size={11} />
                        </button>
                        <button
                          disabled={busy}
                          title={t("users.resetPw")}
                          onClick={() =>
                            setPwReset({
                              id: u.id,
                              password: generatePassword(),
                              done: false,
                            })
                          }
                          className="text-muted hover:text-warn"
                        >
                          <Icon name="KeyRound" size={11} />
                        </button>
                      </div>
                      <div className="mono text-[10.5px] text-muted">
                        {u.email}
                      </div>
                      {pwReset?.id === u.id && (
                        <div className="mt-1.5 flex flex-wrap items-center gap-2 border border-warn-line bg-warn-soft/40 rounded-[4px] px-2 py-1.5">
                          <span className="mono text-[12px] font-bold">
                            {pwReset.password}
                          </span>
                          {pwReset.done ? (
                            <>
                              <span className="text-[10.5px] font-semibold text-brand-deep">
                                {t("users.resetDone")}
                              </span>
                              <button
                                onClick={() => setPwReset(null)}
                                className="text-[10.5px] font-semibold text-muted hover:underline"
                              >
                                {t("users.cancel")}
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                disabled={busy}
                                onClick={async () => {
                                  setBusy(true);
                                  const res = await adminResetPassword(
                                    u.id,
                                    pwReset.password,
                                  );
                                  setBusy(false);
                                  if (res.ok)
                                    setPwReset({ ...pwReset, done: true });
                                }}
                                className="text-[10.5px] font-bold text-warn hover:underline"
                              >
                                {t("users.resetConfirm")}
                              </button>
                              <button
                                onClick={() => setPwReset(null)}
                                className="text-[10.5px] font-semibold text-muted hover:underline"
                              >
                                {t("users.cancel")}
                              </button>
                            </>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </td>
                <td className="px-3.5 py-2.5">
                  <select
                    className="border border-line rounded-[3px] px-2 py-1 text-[12px] bg-surface disabled:bg-subtle disabled:text-muted"
                    value={u.role}
                    disabled={u.id === sessionUid || busy}
                    onChange={async (e) => {
                      setBusy(true);
                      await setUserRole(
                        u.id,
                        e.target.value as "ADMIN" | "MANAGER" | "TECHNICIAN",
                      );
                      setBusy(false);
                      router.refresh();
                    }}
                  >
                    {(["ADMIN", "MANAGER", "TECHNICIAN"] as const).map((r) => (
                      <option key={r} value={r}>
                        {t(`role.${r}` as "role.ADMIN")}
                      </option>
                    ))}
                  </select>
                </td>
                {STEWARDSHIPS.map((s) => (
                  <td key={s.key} className="px-2 py-2.5 text-center">
                    <input
                      type="checkbox"
                      className="accent-[#95CA00] w-4 h-4"
                      checked={u.role === "ADMIN" ? true : u[s.key]}
                      disabled={busy || u.role === "ADMIN"}
                      title={
                        u.role === "ADMIN"
                          ? t("org.adminImplicit")
                          : t(s.label as TKey)
                      }
                      onChange={(e) => toggle(u.id, s.key, e.target.checked)}
                    />
                  </td>
                ))}
                <td className="px-3.5 py-2.5 text-right">
                  {u.id !== sessionUid && (
                    <button
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        await setUserActive(u.id, !u.active);
                        setBusy(false);
                        router.refresh();
                      }}
                      className={
                        "text-[11px] font-semibold " +
                        (u.active
                          ? "text-muted hover:text-danger"
                          : "text-brand-deep hover:underline")
                      }
                    >
                      {t(u.active ? "users.deactivate" : "users.activate")}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-[10.5px] text-muted px-3.5 py-2 border-t border-line">
          {t("org.adminImplicit")}
        </p>
      </section>

      <AddMember onCreated={() => router.refresh()} />

      {/* Pending registrations */}
      <section className="bg-surface border border-line rounded-[6px] p-4">
        <h2 className="text-[13px] font-bold flex items-center gap-1.5 mb-1">
          <Icon name="KeyRound" size={14} className="text-charcoal" />{" "}
          {t("users.pending")}
        </h2>
        <p className="text-[11px] text-muted mb-2.5">
          {t("users.pendingHint")}
        </p>
        {pending.length === 0 ? (
          <p className="text-[12px] text-muted">{t("users.noPending")}</p>
        ) : (
          <div className="space-y-1.5">
            {pending.map((p) => (
              <div
                key={p.email + p.purpose}
                className="flex flex-wrap items-center gap-3 border border-line rounded-[4px] px-3 py-2"
              >
                <span className="mono text-[12px] flex-1 min-w-40">
                  {p.email}
                </span>
                <span className="text-[9.5px] font-bold uppercase px-1.5 py-0.5 rounded-[3px] border border-line bg-subtle text-muted">
                  {t(
                    p.purpose === "reset"
                      ? "users.codeReset"
                      : "users.codeRegister",
                  )}
                </span>
                <span className="mono text-[15px] font-bold tracking-[0.25em] text-brand-deep">
                  {p.code}
                </span>
                <span className="text-[10.5px] text-muted">
                  {t("users.expires")} {p.expiresAt}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// One pending self-registration: the admin fixes the name/handle/email
// styling here (English names, the szpheno.com domain) and may claim a
// legacy imported dataset in the same approval.
function ApprovalCard({
  approval,
  legacyOptions,
  onDone,
}: {
  approval: ApprovalRow;
  legacyOptions: LegacyOptionRow[];
  onDone: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(approval.name);
  const [handle, setHandle] = useState(approval.handle);
  const [email, setEmail] = useState(approval.email);
  const [legacyUserId, setLegacyUserId] = useState(
    approval.suggestedLegacyId ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  return (
    <div className="border border-line rounded-[5px] p-3">
      <p className="text-[11px] text-muted mb-2">
        {t("appr.registered")} <span className="mono">{approval.email}</span> ·{" "}
        {approval.createdAt}
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-2">
        <div>
          <FieldLabel>{t("users.name")}</FieldLabel>
          <input
            className={inputCls}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <FieldLabel>{t("appr.handle")}</FieldLabel>
          <input
            className={inputCls}
            value={handle}
            placeholder="@joey"
            onChange={(e) => setHandle(e.target.value)}
          />
        </div>
        <div>
          <FieldLabel>{t("users.email")}</FieldLabel>
          <input
            type="email"
            className={inputCls + " mono"}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
      </div>
      <div className="mb-2.5">
        <FieldLabel>{t("appr.legacy")}</FieldLabel>
        <p className="text-[10.5px] text-muted mb-1">{t("appr.legacyHint")}</p>
        <select
          className="h-9 w-full sm:w-auto border border-line rounded-[4px] px-2 text-[12.5px] bg-surface"
          value={legacyUserId}
          onChange={(e) => setLegacyUserId(e.target.value)}
        >
          <option value="">{t("appr.noLegacy")}</option>
          {legacyOptions.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name} · {t("appr.expCount", { n: String(l.experiments) })}
              {l.id === approval.suggestedLegacyId
                ? ` (${t("appr.suggested")})`
                : ""}
            </option>
          ))}
        </select>
      </div>
      {error && <p className="text-[12px] text-danger mb-2">{error}</p>}
      <div className="flex gap-2">
        <button
          disabled={busy || !name.trim() || !email.includes("@")}
          onClick={async () => {
            setBusy(true);
            setError("");
            const res = await approveRegistration({
              userId: approval.id,
              name,
              handle,
              email,
              legacyUserId,
            });
            setBusy(false);
            if (!res.ok) {
              setError(
                t(
                  res.error === "exists"
                    ? "users.emailTaken"
                    : "users.badInput",
                ),
              );
              return;
            }
            onDone();
          }}
          className="h-9 px-4 bg-brand text-[#243000] rounded-[4px] text-[12.5px] font-bold disabled:opacity-50"
        >
          {t("appr.approve")}
        </button>
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await rejectRegistration(approval.id);
            setBusy(false);
            onDone();
          }}
          className="h-9 px-3 text-[12px] font-semibold text-danger border border-danger/40 rounded-[4px] disabled:opacity-50"
        >
          {t("appr.reject")}
        </button>
      </div>
    </div>
  );
}

// Admin creates a login directly — for colleagues who cannot receive the
// passcode email. Credentials stay visible after creation so they can be
// copied and handed over.
function AddMember({ onCreated }: { onCreated: () => void }) {
  const t = useT();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"ADMIN" | "MANAGER" | "TECHNICIAN">(
    "TECHNICIAN",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<{
    email: string;
    password: string;
  } | null>(null);

  const generate = () => {
    const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
    const arr = new Uint32Array(12);
    crypto.getRandomValues(arr);
    setPassword([...arr].map((n) => chars[n % chars.length]).join(""));
  };

  return (
    <section className="bg-surface border border-line rounded-[6px] p-4">
      <h2 className="text-[13px] font-bold flex items-center gap-1.5 mb-1">
        <Icon name="UserPlus" size={14} className="text-charcoal" />{" "}
        {t("users.add")}
      </h2>
      <p className="text-[11px] text-muted mb-3">{t("users.addHint")}</p>
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_1.2fr_1fr_auto_auto] gap-2 items-end">
        <div>
          <FieldLabel>{t("users.name")}</FieldLabel>
          <input
            className={inputCls}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <FieldLabel>{t("users.email")}</FieldLabel>
          <input
            type="email"
            className={inputCls + " mono"}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div>
          <FieldLabel>{t("users.password")}</FieldLabel>
          <div className="flex gap-1.5">
            <input
              className={inputCls + " mono"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button
              type="button"
              onClick={generate}
              title={t("users.generate")}
              className="shrink-0 h-9 px-2.5 border border-line rounded-[4px] text-muted hover:bg-subtle"
            >
              <Icon name="Dices" size={14} />
            </button>
          </div>
        </div>
        <div>
          <FieldLabel>{t("users.role")}</FieldLabel>
          <select
            className="h-9 border border-line rounded-[4px] px-2 text-[12.5px] bg-surface"
            value={role}
            onChange={(e) => setRole(e.target.value as typeof role)}
          >
            {(["TECHNICIAN", "MANAGER", "ADMIN"] as const).map((r) => (
              <option key={r} value={r}>
                {t(`role.${r}` as "role.ADMIN")}
              </option>
            ))}
          </select>
        </div>
        <button
          disabled={busy || !email.includes("@") || password.length < 8}
          onClick={async () => {
            setBusy(true);
            setError("");
            setCreated(null);
            const res = await createUserAccount({
              name,
              email,
              password,
              role,
            });
            setBusy(false);
            if (!res.ok) {
              setError(
                t(
                  res.error === "exists"
                    ? "users.emailTaken"
                    : "users.badInput",
                ),
              );
              return;
            }
            setCreated({ email: email.trim().toLowerCase(), password });
            setName("");
            setEmail("");
            setPassword("");
            onCreated();
          }}
          className="h-9 bg-brand text-[#243000] rounded-[4px] px-4 text-[12.5px] font-bold disabled:opacity-50 whitespace-nowrap"
        >
          {t("users.create")}
        </button>
      </div>
      {password.length > 0 && password.length < 8 && (
        <p className="text-[11px] text-warn mt-1.5">{t("users.pwShort")}</p>
      )}
      {error && <p className="text-[12px] text-danger mt-2">{error}</p>}
      {created && (
        <div className="mt-3 flex flex-wrap items-center gap-3 bg-brand-soft/50 border border-brand/40 rounded-[4px] px-3 py-2">
          <span className="text-[11.5px] font-semibold text-brand-deep">
            {t("users.created")}
          </span>
          <span className="mono text-[12px]">{created.email}</span>
          <span className="mono text-[13px] font-bold text-brand-deep">
            {created.password}
          </span>
        </div>
      )}
    </section>
  );
}
