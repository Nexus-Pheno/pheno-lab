"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { changePassword } from "@/lib/actions/profile";
import { useT } from "@/lib/i18n/LanguageProvider";

export function FirstPassword({ destination }: { destination: string }) {
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <form
      className="space-y-4"
      onSubmit={async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const next = String(form.get("next"));
        if (next !== form.get("confirm")) {
          setError(t("profile.passwordMismatch"));
          return;
        }
        setBusy(true);
        setError("");
        try {
          const result = await changePassword(
            String(form.get("current")),
            next,
          );
          if (!result.ok) {
            setError(
              result.error === "wrong-current"
                ? t("profile.passwordWrong")
                : result.error === "same-password"
                  ? t("testing.passwordDifferent")
                  : t("testing.passwordError"),
            );
            return;
          }
          router.replace(destination);
          router.refresh();
        } catch {
          setError(t("testing.passwordError"));
        } finally {
          setBusy(false);
        }
      }}
    >
      {[
        ["current", "profile.currentPassword", "current-password"],
        ["next", "profile.newPassword", "new-password"],
        ["confirm", "profile.confirmPassword", "new-password"],
      ].map(([name, key, auto]) => (
        <label className="block text-sm" key={name}>
          {t(key as "profile.currentPassword")}
          <input
            name={name}
            type="password"
            autoComplete={auto}
            required
            minLength={name === "current" ? 1 : 8}
            maxLength={128}
            className="block mt-1 w-full border border-line rounded px-3 py-2.5"
          />
        </label>
      ))}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <button
        disabled={busy}
        className="w-full bg-brand text-ink font-bold rounded px-4 py-2.5 disabled:opacity-50"
      >
        {t("testing.savePassword")}
      </button>
    </form>
  );
}
