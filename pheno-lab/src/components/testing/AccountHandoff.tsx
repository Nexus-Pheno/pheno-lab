"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { revealTemporaryLogin } from "@/lib/actions/testing";
import { useT } from "@/lib/i18n/LanguageProvider";

export function AccountHandoff({ id }: { id: string }) {
  const t = useT();
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), 30_000);
    return () => clearInterval(timer);
  }, [router]);
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-3">
      {password ? (
        <label className="block text-sm">
          {t("login.password")}
          <input
            aria-label={t("testing.temporaryPassword")}
            readOnly
            value={password}
            className="block mt-1 w-full border border-line rounded p-3 font-mono"
          />
        </label>
      ) : (
        <button
          disabled={busy}
          className="bg-brand text-ink font-semibold rounded px-4 py-2.5 disabled:opacity-50"
          onClick={async () => {
            setBusy(true);
            try {
              setPassword(await revealTemporaryLogin(id));
            } catch {
              setError(true);
            } finally {
              setBusy(false);
            }
          }}
        >
          {t("testing.reveal")}
        </button>
      )}
      {error && (
        <p role="alert" className="text-danger text-sm">
          {t("testing.handoffUnavailable")}
        </p>
      )}
    </div>
  );
}
