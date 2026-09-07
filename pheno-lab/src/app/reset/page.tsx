"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  requestPasswordReset,
  verifyPasswordReset,
} from "@/lib/actions/registration";
import { useT } from "@/lib/i18n/LanguageProvider";
import { FieldLabel, inputCls } from "@/components/ui";

// Forgot-password flow, mirroring /register's three stages. The request
// stage always advances — the server deliberately answers the same way
// whether or not the email has an account.
export default function ResetPage() {
  const t = useT();
  const [stage, setStage] = useState<"email" | "code" | "done">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [emailed, setEmailed] = useState(false);

  return (
    <main className="min-h-dvh bg-subtle flex items-center justify-center p-6">
      <div className="w-full max-w-sm bg-surface border border-line rounded-[8px] p-8">
        <Image
          src="/brand/pheno-logo.png"
          alt="Pheno"
          width={120}
          height={35}
          className="mb-1"
          priority
        />
        <h1 className="text-sm font-semibold text-charcoal mb-1">
          {t("reset.title")}
        </h1>
        <p className="text-[11.5px] text-muted mb-5">{t("reset.subtitle")}</p>

        {stage === "email" && (
          <div className="space-y-4">
            <div>
              <FieldLabel>{t("reg.email")}</FieldLabel>
              <input
                type="email"
                className={inputCls}
                value={email}
                autoFocus
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <button
              disabled={busy || !email.includes("@")}
              onClick={async () => {
                setBusy(true);
                const res = await requestPasswordReset(email);
                setBusy(false);
                setEmailed(res.emailed);
                setStage("code");
              }}
              className="w-full bg-ink text-white rounded-[4px] py-2.5 text-sm font-semibold disabled:opacity-50"
            >
              {t("reset.request")}
            </button>
          </div>
        )}

        {stage === "code" && (
          <div className="space-y-3.5">
            <p className="text-[11.5px] text-brand-deep bg-brand-soft border border-brand/40 rounded-[4px] p-2.5">
              {t(emailed ? "reset.codeEmailed" : "reset.codeSent")}
            </p>
            <div>
              <FieldLabel>{t("reg.code")}</FieldLabel>
              <input
                inputMode="numeric"
                maxLength={6}
                autoFocus
                className={
                  inputCls + " mono text-center text-lg tracking-[0.4em]"
                }
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              />
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <FieldLabel>{t("reset.password")}</FieldLabel>
                <input
                  type="password"
                  className={inputCls}
                  value={pw}
                  onChange={(e) => setPw(e.target.value)}
                />
              </div>
              <div>
                <FieldLabel>{t("reg.password2")}</FieldLabel>
                <input
                  type="password"
                  className={inputCls}
                  value={pw2}
                  onChange={(e) => setPw2(e.target.value)}
                />
              </div>
            </div>
            {error && <p className="text-sm text-danger">{error}</p>}
            <button
              disabled={
                busy || code.length !== 6 || pw.length < 8 || pw !== pw2
              }
              onClick={async () => {
                setBusy(true);
                setError("");
                const res = await verifyPasswordReset({
                  email,
                  code,
                  password: pw,
                });
                setBusy(false);
                if (res.ok) setStage("done");
                else setError(t("reg.badCode"));
              }}
              className="w-full bg-ink text-white rounded-[4px] py-2.5 text-sm font-semibold disabled:opacity-50"
            >
              {t("reset.submit")}
            </button>
          </div>
        )}

        {stage === "done" && (
          <p className="text-sm text-brand-deep">{t("reset.done")}</p>
        )}

        <p className="mt-4 text-center">
          <Link
            href="/login"
            className="text-[12px] font-semibold text-muted hover:underline"
          >
            {t("reg.backToLogin")}
          </Link>
        </p>
      </div>
    </main>
  );
}
