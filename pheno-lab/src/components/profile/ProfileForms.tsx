"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { updateProfile, changePassword, setLanguage } from "@/lib/actions/profile";
import { useT } from "@/lib/i18n/LanguageProvider";
import { Icon, FieldLabel, inputCls, selectCls } from "@/components/ui";

const sectionCls = "bg-surface border border-line rounded-[6px] p-4";

export function ProfileForms({
  user,
  orgName,
}: {
  user: { name: string; handle: string; email: string; language: "en" | "zh"; role: string; createdAt: string };
  orgName: string;
}) {
  const t = useT();
  const router = useRouter();
  const [name, setName] = useState(user.name);
  const [handle, setHandle] = useState(user.handle);
  const [profileMsg, setProfileMsg] = useState("");
  const [pw, setPw] = useState({ current: "", next: "", confirm: "" });
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div className="space-y-4">
      {/* Profile */}
      <section className={sectionCls}>
        <h2 className="text-[13px] font-bold mb-3">{t("profile.title")}</h2>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <FieldLabel>{t("profile.displayName")}</FieldLabel>
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <FieldLabel>{t("profile.handle")}</FieldLabel>
            <input className={inputCls + " mono"} placeholder={t("profile.handlePh")} value={handle} onChange={(e) => setHandle(e.target.value)} />
          </div>
        </div>
        <div className="flex items-center gap-2.5 mt-3">
          <button
            disabled={busy || !name.trim()}
            onClick={async () => {
              setBusy(true);
              await updateProfile({ name, handle });
              setProfileMsg(t("profile.saved"));
              setBusy(false);
              router.refresh();
            }}
            className="bg-ink text-white rounded-[4px] px-4 py-1.5 text-[12px] font-semibold disabled:opacity-50"
          >
            {t("profile.save")}
          </button>
          {profileMsg && <span className="text-[12px] text-brand-deep">{profileMsg}</span>}
        </div>
      </section>

      {/* Login information */}
      <section className={sectionCls}>
        <h2 className="text-[13px] font-bold mb-3">{t("profile.loginInfo")}</h2>
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <FieldLabel>{t("profile.email")}</FieldLabel>
            <input className={inputCls + " mono"} value={user.email} disabled />
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <FieldLabel>{t("profile.currentPassword")}</FieldLabel>
            <input type="password" className={inputCls} value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
          </div>
          <div>
            <FieldLabel>{t("profile.newPassword")}</FieldLabel>
            <input type="password" className={inputCls} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
          </div>
          <div>
            <FieldLabel>{t("profile.confirmPassword")}</FieldLabel>
            <input type="password" className={inputCls} value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
          </div>
        </div>
        <div className="flex items-center gap-2.5 mt-3">
          <button
            disabled={busy || !pw.current || !pw.next}
            onClick={async () => {
              if (pw.next !== pw.confirm) {
                setPwMsg({ ok: false, text: t("profile.passwordMismatch") });
                return;
              }
              setBusy(true);
              const res = await changePassword(pw.current, pw.next);
              setPwMsg(res.ok ? { ok: true, text: t("profile.passwordChanged") } : { ok: false, text: t("profile.passwordWrong") });
              if (res.ok) setPw({ current: "", next: "", confirm: "" });
              setBusy(false);
            }}
            className="border border-line rounded-[4px] px-4 py-1.5 text-[12px] font-semibold hover:bg-subtle disabled:opacity-50"
          >
            {t("profile.changePassword")}
          </button>
          {pwMsg && <span className={"text-[12px] " + (pwMsg.ok ? "text-brand-deep" : "text-danger")}>{pwMsg.text}</span>}
        </div>
      </section>

      {/* Organization + language */}
      <section className={sectionCls}>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <h2 className="text-[13px] font-bold mb-3">{t("profile.organization")}</h2>
            <div className="text-[13px]">{orgName}</div>
            <div className="text-[11px] text-muted mt-1">
              {t("profile.role")}: {t(`role.${user.role}` as "role.ADMIN")} · {t("profile.memberSince")}{" "}
              <span className="mono">{user.createdAt}</span>
            </div>
          </div>
          <div>
            <h2 className="text-[13px] font-bold mb-3">{t("profile.language")}</h2>
            <select
              className={selectCls}
              defaultValue={user.language}
              onChange={async (e) => {
                await setLanguage(e.target.value as "en" | "zh");
                router.refresh();
              }}
            >
              <option value="en">English</option>
              <option value="zh">中文（简体）</option>
            </select>
            <p className="text-[10px] text-muted mt-1">{t("profile.langHint")}</p>
          </div>
        </div>
      </section>
    </div>
  );
}

