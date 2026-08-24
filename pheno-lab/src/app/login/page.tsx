"use client";

import Image from "next/image";
import Link from "next/link";
import { useActionState } from "react";
import { login } from "@/lib/actions/auth";
import { useT } from "@/lib/i18n/LanguageProvider";

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(login, null);
  const t = useT();

  return (
    <main className="min-h-dvh bg-subtle flex items-center justify-center p-6">
      <div className="w-full max-w-sm bg-surface border border-line rounded-[8px] p-8">
        <Image src="/brand/pheno-logo.png" alt="Pheno" width={120} height={35} className="mb-1" priority />
        <h1 className="text-sm font-semibold text-charcoal mb-6">{t("app.name")}</h1>
        <form action={formAction} className="space-y-4">
          <div>
            <label htmlFor="email" className="block text-[11px] font-bold uppercase text-muted mb-1">
              {t("login.email")}
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="username"
              className="w-full border border-line rounded-[4px] px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label htmlFor="password" className="block text-[11px] font-bold uppercase text-muted mb-1">
              {t("login.password")}
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className="w-full border border-line rounded-[4px] px-3 py-2 text-sm"
            />
          </div>
          {state?.error && <p className="text-sm text-danger">{t("login.invalid")}</p>}
          <button
            type="submit"
            disabled={pending}
            className="w-full bg-ink text-white rounded-[4px] py-2.5 text-sm font-semibold disabled:opacity-60"
          >
            {pending ? t("login.signingin") : t("login.signin")}
          </button>
        </form>
        <p className="mt-4 text-center">
          <Link href="/register" className="text-[12px] font-semibold text-brand-deep hover:underline">
            {t("reg.link")}
          </Link>
        </p>
      </div>
    </main>
  );
}
