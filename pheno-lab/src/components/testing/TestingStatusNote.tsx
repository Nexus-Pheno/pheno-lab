import { fmtBeijing } from "@/lib/datetime";
import type { TKey } from "@/lib/i18n/dict";

export function TestingStatusNote({
  manual,
  automaticComplete,
  t,
}: {
  manual: { reason: string; updatedAt: string } | null;
  automaticComplete: boolean;
  t: (key: TKey) => string;
}) {
  return (
    <div
      className="text-xs text-muted mt-2 break-words"
      data-testing-status-source={manual ? "MANUAL" : "AUTO"}
    >
      {manual ? (
        <>
          <p>
            {t("testing.status.manual")} ·{" "}
            {fmtBeijing(new Date(manual.updatedAt))}
          </p>
          <p className="mt-1">
            {t("testing.status.reason")}: {manual.reason}
          </p>
          <p className="mt-1">
            {t("testing.status.automatic")}:{" "}
            {t(automaticComplete ? "testing.completed" : "testing.inProgress")}
          </p>
        </>
      ) : (
        t("testing.status.automatic")
      )}
    </div>
  );
}
