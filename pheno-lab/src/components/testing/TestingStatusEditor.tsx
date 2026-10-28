"use client";

import { useState, useTransition } from "react";
import { useT } from "@/lib/i18n/LanguageProvider";
import { updateTestingStatus } from "@/lib/actions/testing";

export function TestingStatusEditor({
  experimentId,
  requestSetKey,
}: {
  experimentId: string;
  requestSetKey: string;
}) {
  const t = useT();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<
    "saved" | "invalid" | "forbidden" | "changed" | "failed" | null
  >(null);
  return (
    <details className="mt-3 text-sm" data-testing-status-editor>
      <summary className="cursor-pointer font-semibold text-brand-deep py-1">
        {t("testing.status.edit")}
      </summary>
      <form
        className="mt-2 space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const submitter = (event.nativeEvent as SubmitEvent).submitter;
          const data = new FormData(form, submitter);
          setMessage(null);
          startTransition(async () => {
            try {
              const result = await updateTestingStatus({
                experimentId,
                requestSetKey,
                status: data.get("status"),
                reason: data.get("reason"),
              });
              setMessage(result.ok ? "saved" : result.error);
              if (result.ok) form.reset();
            } catch {
              setMessage("failed");
            }
          });
        }}
      >
        <p className="text-xs text-muted">{t("testing.status.hint")}</p>
        <fieldset disabled={pending} className="space-y-2">
          <label className="block">
            <span className="block text-xs font-semibold mb-1">
              {t("testing.status.reason")}
            </span>
            <textarea
              name="reason"
              required
              maxLength={500}
              rows={2}
              className="block w-full rounded border border-line bg-surface p-2 text-sm resize-y"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            {(["COMPLETE", "IN_PROGRESS", "AUTO"] as const).map((status) => (
              <button
                key={status}
                name="status"
                value={status}
                type="submit"
                className="min-h-10 rounded border border-line bg-surface px-3 text-xs font-semibold hover:bg-subtle disabled:opacity-50"
              >
                {t(
                  status === "COMPLETE"
                    ? "testing.status.markComplete"
                    : status === "IN_PROGRESS"
                      ? "testing.status.markInProgress"
                      : "testing.status.restore",
                )}
              </button>
            ))}
          </div>
        </fieldset>
        {pending ? (
          <p role="status" className="text-xs text-muted">
            {t("testing.status.saving")}
          </p>
        ) : message ? (
          <p
            role={message === "saved" ? "status" : "alert"}
            className="text-xs"
          >
            {t(`testing.status.${message}`)}
          </p>
        ) : null}
      </form>
    </details>
  );
}
