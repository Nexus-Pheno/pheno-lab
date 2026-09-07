"use client";

import Image from "next/image";
import Link from "next/link";
import { useActionState, useState } from "react";
import { login } from "@/lib/actions/auth";
import { useT } from "@/lib/i18n/LanguageProvider";
import { Icon } from "@/components/ui";
import { BadgeLogin } from "./BadgeLogin";

/**
 * The sign-in card. On a registered shared tablet it grows a kiosk badge and
 * tap-to-pick name tiles: tapping a name selects the account (by id — the
 * email never appears on a shared screen) and leaves just a password field.
 * Typing an email the normal way is always available underneath.
 */
export function LoginForm({
  device,
  quickUsers,
  claim,
}: {
  device: { label: string } | null;
  quickUsers: { id: string; name: string }[];
  claim: string;
}) {
  const [state, formAction, pending] = useActionState(login, null);
  const [selected, setSelected] = useState<{ id: string; name: string } | null>(
    null,
  );
  const t = useT();

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
        <h1 className="text-sm font-semibold text-charcoal mb-4">
          {t("app.name")}
        </h1>

        {claim === "ok" && (
          <p className="mb-3 text-[12px] font-semibold text-brand-deep bg-brand-soft border border-brand/40 rounded-[4px] px-2.5 py-1.5">
            {t("kiosk.claimDone")}
          </p>
        )}
        {claim === "invalid" && (
          <p className="mb-3 text-[12px] font-semibold text-danger border border-danger/40 rounded-[4px] px-2.5 py-1.5">
            {t("kiosk.claimInvalid")}
          </p>
        )}

        {device && (
          <div className="mb-4 border border-brand/40 bg-brand-soft/50 rounded-[6px] px-3 py-2">
            <p className="text-[12px] font-bold text-brand-deep flex items-center gap-1.5">
              <Icon name="Tablet" size={13} /> {device.label}
            </p>
            <p className="text-[10.5px] text-muted mt-0.5">
              {t("kiosk.loginHint")}
            </p>
            {quickUsers.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {quickUsers.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() =>
                      setSelected(selected?.id === u.id ? null : u)
                    }
                    className={
                      "h-6 px-2.5 rounded-full text-[10.5px] font-bold border " +
                      (selected?.id === u.id
                        ? "bg-ink text-white border-ink"
                        : "bg-surface text-brand-deep border-brand/40")
                    }
                  >
                    {u.name.trim().split(/\s+/)[0] || u.name}
                  </button>
                ))}
              </div>
            )}
            <BadgeLogin />
          </div>
        )}

        <form action={formAction} className="space-y-4">
          {selected ? (
            <div>
              <input type="hidden" name="userId" value={selected.id} />
              <div className="flex items-center gap-2 border border-line rounded-[4px] px-3 py-2 bg-subtle">
                <span className="h-6 px-2 rounded-full bg-brand-soft border border-brand/40 text-[10px] font-bold text-brand-deep flex items-center">
                  {selected.name.trim().split(/\s+/)[0] || selected.name}
                </span>
                <span className="text-sm font-semibold flex-1 truncate">
                  {selected.name}
                </span>
                <button
                  type="button"
                  onClick={() => setSelected(null)}
                  className="text-[11px] font-semibold text-brand-deep hover:underline shrink-0"
                >
                  {t("login.switchUser")}
                </button>
              </div>
            </div>
          ) : (
            <div>
              <label
                htmlFor="email"
                className="block text-[11px] font-bold uppercase text-muted mb-1"
              >
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
          )}
          <div>
            <label
              htmlFor="password"
              className="block text-[11px] font-bold uppercase text-muted mb-1"
            >
              {t("login.password")}
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete={device ? "off" : "current-password"}
              className="w-full border border-line rounded-[4px] px-3 py-2 text-sm"
            />
          </div>
          {state?.error && (
            <p className="text-sm text-danger">
              {t(state.error === "pending" ? "login.pending" : "login.invalid")}
            </p>
          )}
          <button
            type="submit"
            disabled={pending}
            className="w-full bg-ink text-white rounded-[4px] py-2.5 text-sm font-semibold disabled:opacity-60"
          >
            {pending ? t("login.signingin") : t("login.signin")}
          </button>
        </form>
        <p className="mt-4 text-center">
          <Link
            href="/register"
            className="text-[12px] font-semibold text-brand-deep hover:underline"
          >
            {t("reg.link")}
          </Link>
        </p>
      </div>
    </main>
  );
}
