"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { requestRegistration, verifyRegistration } from "@/lib/actions/registration";
import { useT } from "@/lib/i18n/LanguageProvider";
import { FieldLabel, inputCls } from "@/components/ui";

export default function RegisterPage() {
  const t = useT();
  const [stage, setStage] = useState<"email" | "code" | "done">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [emailed, setEmailed] = useState(false);

  const errText = (e: string) =>
    e === "bad-domain" ? t("reg.badDomain") : e === "exists" ? t("reg.exists") : t("reg.badCode");

  return (
    <main className="min-h-dvh bg-subtle flex items-center justify-center p-6">
      <div className="w-full max-w-sm bg-surface border border-line rounded-[8px] p-8">
        <Image src="/brand/pheno-logo.png" alt="Pheno" width={120} height={35} className="mb-1" priority />
        <h1 className="text-sm font-semibold text-charcoal mb-1">{t("reg.title")}</h1>
        <p className="text-[11.5px] text-muted mb-5">{t("reg.subtitle")}</p>

        {stage === "email" && (
          <div className="space-y-4">
            <div>
              <FieldLabel>{t("reg.email")}</FieldLabel>
              <input type="email" className={inputCls} value={email} autoFocus
                onChange={(e) => setEmail(e.target.value)} />
            </div>
            {error && <p className="text-sm text-danger">{error}</p>}
            <button
              disabled={busy || !email.includes("@")}
              onClick={async () => {
                setBusy(true);
                setError("");
                const res = await requestRegistration(email);
                setBusy(false);
                if (res.ok) {
                  setEmailed(res.emailed ?? false);
                  setStage("code");
                } else setError(errText(res.error ?? ""));
              }}
              className="w-full bg-ink text-white rounded-[4px] py-2.5 text-sm font-semibold disabled:opacity-50"
            >
              {t("reg.request")}
            </button>
          </div>
        )}

        {stage === "code" && (
          <div className="space-y-3.5">
            <p className="text-[11.5px] text-brand-deep bg-brand-soft border border-brand/40 rounded-[4px] p-2.5">
              {t(emailed ? "reg.codeEmailed" : "reg.codeSent")}
            </p>
            <div>
              <FieldLabel>{t("reg.code")}</FieldLabel>
              <input inputMode="numeric" maxLength={6} autoFocus
                className={inputCls + " mono text-center text-lg tracking-[0.4em]"}
                value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
            </div>
            <div>
              <FieldLabel>{t("reg.name")}</FieldLabel>
              <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <FieldLabel>{t("reg.password")}</FieldLabel>
                <input type="password" className={inputCls} value={pw} onChange={(e) => setPw(e.target.value)} />
              </div>
              <div>
                <FieldLabel>{t("reg.password2")}</FieldLabel>
                <input type="password" className={inputCls} value={pw2} onChange={(e) => setPw2(e.target.value)} />
              </div>
            </div>
            {error && <p className="text-sm text-danger">{error}</p>}
            <button
              disabled={busy || code.length !== 6 || !name.trim() || pw.length < 8 || pw !== pw2}
              onClick={async () => {
                setBusy(true);
                setError("");
                const res = await verifyRegistration({ email, code, name, password: pw });
                setBusy(false);
                if (res.ok) setStage("done");
                else setError(errText(res.error ?? ""));
              }}
              className="w-full bg-ink text-white rounded-[4px] py-2.5 text-sm font-semibold disabled:opacity-50"
            >
              {t("reg.submit")}
            </button>
          </div>
        )}

        {stage === "done" && (
          <p className="text-sm text-brand-deep">{t("reg.done")}</p>
        )}

        <p className="mt-4 text-center">
          <Link href="/login" className="text-[12px] font-semibold text-muted hover:underline">
            {t("reg.backToLogin")}
          </Link>
        </p>
      </div>
    </main>
  );
}
