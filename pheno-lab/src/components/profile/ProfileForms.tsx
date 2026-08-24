"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { updateProfile, changePassword, setLanguage, submitFeedback } from "@/lib/actions/profile";
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

export function FeedbackForm() {
  const t = useT();
  const [kind, setKind] = useState<"bug" | "feedback">("bug");
  const [message, setMessage] = useState("");
  const [screenshotPath, setScreenshotPath] = useState("");
  const [includeErrors, setIncludeErrors] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const json = await res.json();
      if (json.fileName) setScreenshotPath(json.fileName);
      else alert(json.error ?? "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  return (
    <section className={sectionCls}>
      <h2 className="text-[13px] font-bold mb-1 flex items-center gap-1.5">
        <Icon name="Bug" size={14} className="text-charcoal" /> {t("fb.title")}
      </h2>
      {done ? (
        <p className="text-[13px] text-brand-deep flex items-center gap-1.5 mt-2">
          <Icon name="Check" size={14} /> {t("fb.submitted")}
        </p>
      ) : (
        <div className="space-y-3 mt-2">
          <div className="flex gap-2">
            {(["bug", "feedback"] as const).map((k) => (
              <button
                key={k}
                onClick={() => setKind(k)}
                className={
                  "text-[12px] font-semibold px-3 py-1.5 rounded-[4px] border " +
                  (kind === k ? "bg-brand-soft text-brand-deep border-brand/40" : "border-line text-muted hover:bg-subtle")
                }
              >
                {t(k === "bug" ? "fb.bug" : "fb.feedback")}
              </button>
            ))}
          </div>
          <div>
            <FieldLabel>{t("fb.message")}</FieldLabel>
            <textarea
              className={inputCls + " resize-none"}
              rows={4}
              placeholder={t("fb.messagePh")}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <input ref={fileRef} type="file" accept="image/*" className="hidden"
              onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
            <button
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="text-[12px] font-semibold border border-line rounded-[4px] px-3 py-1.5 hover:bg-subtle disabled:opacity-50 flex items-center gap-1.5"
            >
              <Icon name="Camera" size={13} />
              {uploading ? t("lib.uploading") : screenshotPath ? t("fb.attached") : t("fb.attach")}
            </button>
            {screenshotPath && <Icon name="CheckCircle2" size={14} className="text-brand-deep" />}
            <label className="flex items-center gap-1.5 text-[12px] text-charcoal">
              <input type="checkbox" checked={includeErrors} onChange={(e) => setIncludeErrors(e.target.checked)} />
              {t("fb.includeErrors")}
            </label>
          </div>
          <div className="flex justify-end">
            <button
              disabled={busy || !message.trim()}
              onClick={async () => {
                setBusy(true);
                await submitFeedback({
                  kind,
                  message,
                  screenshotPath,
                  errorLog: includeErrors ? (window.__phenoErrors ?? []).join("\n") : "",
                  pageUrl: window.location.href,
                  userAgent: navigator.userAgent,
                });
                setBusy(false);
                setDone(true);
              }}
              className="bg-ink text-white rounded-[4px] px-5 py-1.5 text-[12px] font-bold disabled:opacity-50"
            >
              {t("fb.submit")}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
