import type { TKey } from "@/lib/i18n/dict";

export function TestingCompletion({
  complete,
  t,
}: {
  complete: boolean;
  t: (key: TKey) => string;
}) {
  return (
    <span
      data-testing-complete={String(complete)}
      className={
        "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold " +
        (complete ? "bg-emerald-100 text-emerald-800" : "bg-subtle text-muted")
      }
    >
      {complete && <span aria-hidden="true">✓</span>}
      {t(complete ? "testing.completed" : "testing.inProgress")}
    </span>
  );
}
