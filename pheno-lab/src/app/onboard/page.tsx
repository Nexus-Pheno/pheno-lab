"use client";

import { Suspense, useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { checkInvite, submitOrganization } from "@/lib/actions/orgs";
import { useT } from "@/lib/i18n/LanguageProvider";
import { FieldLabel, inputCls } from "@/components/ui";

function OnboardForm() {
  const t = useT();
  const token = useSearchParams().get("token") ?? "";
  const [tokenState, setTokenState] = useState<
    "checking" | "valid" | "invalid"
  >("checking");
  const [orgName, setOrgName] = useState("");
  const [domains, setDomains] = useState("");
  const [adminName, setAdminName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const displayedTokenState = token ? tokenState : "invalid";

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    checkInvite(token).then((result) => {
      if (!cancelled) setTokenState(result.valid ? "valid" : "invalid");
    });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const errText = (e: string) =>
    e === "exists"
      ? t("reg.exists")
      : e === "email-domain"
        ? t("onboard.emailDomain")
        : e === "bad-token"
          ? t("onboard.badToken")
          : t("onboard.badInput");

  return (
    <main className="min-h-dvh bg-subtle flex items-center justify-center p-6">
      <div className="w-full max-w-md bg-surface border border-line rounded-[8px] p-8">
        <Image
          src="/brand/pheno-logo.png"
          alt="Pheno"
          width={120}
          height={35}
          className="mb-1"
          priority
        />
        <h1 className="text-sm font-semibold text-charcoal mb-1">
          {t("onboard.title")}
        </h1>
        <p className="text-[11.5px] text-muted mb-5">{t("onboard.subtitle")}</p>

        {displayedTokenState === "checking" && (
          <p className="text-sm text-muted">…</p>
        )}

        {displayedTokenState === "invalid" && (
          <p className="text-sm text-danger">{t("onboard.badToken")}</p>
        )}

        {displayedTokenState === "valid" && !done && (
          <div className="space-y-3.5">
            <div>
              <FieldLabel>{t("onboard.orgName")}</FieldLabel>
              <input
                className={inputCls}
                value={orgName}
                autoFocus
                onChange={(e) => setOrgName(e.target.value)}
              />
            </div>
            <div>
              <FieldLabel>{t("onboard.domains")}</FieldLabel>
              <input
                className={inputCls + " mono"}
                placeholder="acme.com, acme.cn"
                value={domains}
                onChange={(e) => setDomains(e.target.value)}
              />
              <p className="text-[10px] text-muted mt-1">
                {t("onboard.domainsHint")}
              </p>
            </div>
            <div className="border-t border-line pt-3.5">
              <p className="text-[11px] font-bold uppercase text-muted mb-2">
                {t("onboard.adminSection")}
              </p>
              <div className="space-y-3">
                <div>
                  <FieldLabel>{t("reg.name")}</FieldLabel>
                  <input
                    className={inputCls}
                    value={adminName}
                    onChange={(e) => setAdminName(e.target.value)}
                  />
                </div>
                <div>
                  <FieldLabel>{t("onboard.adminEmail")}</FieldLabel>
                  <input
                    type="email"
                    className={inputCls + " mono"}
                    value={adminEmail}
                    onChange={(e) => setAdminEmail(e.target.value)}
                  />
                </div>
                <div className="grid grid-cols-2 gap-2.5">
                  <div>
                    <FieldLabel>{t("reg.password")}</FieldLabel>
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
              </div>
            </div>
            {error && <p className="text-sm text-danger">{error}</p>}
            <button
              disabled={
                busy ||
                !orgName.trim() ||
                !domains.trim() ||
                !adminEmail.includes("@") ||
                pw.length < 8
              }
              onClick={async () => {
                if (pw !== pw2) {
                  setError(t("profile.passwordMismatch"));
                  return;
                }
                setBusy(true);
                setError("");
                const res = await submitOrganization({
                  token,
                  orgName,
                  domainsCsv: domains,
                  adminName,
                  adminEmail,
                  password: pw,
                });
                setBusy(false);
                if (res.ok) setDone(true);
                else setError(errText(res.error ?? ""));
              }}
              className="w-full bg-ink text-white rounded-[4px] py-2.5 text-sm font-semibold disabled:opacity-50"
            >
              {t("onboard.submit")}
            </button>
          </div>
        )}

        {done && (
          <div className="space-y-4">
            <p className="text-sm text-brand-deep">{t("onboard.done")}</p>
            <Link
              href="/login"
              className="block text-center text-[12.5px] font-semibold text-charcoal hover:underline"
            >
              {t("reg.backToLogin")}
            </Link>
          </div>
        )}
      </div>
    </main>
  );
}

export default function OnboardPage() {
  return (
    <Suspense>
      <OnboardForm />
    </Suspense>
  );
}
