// Idle-draft policy (Michael, 2026-09-16), kept pure so the sweep and the
// tests agree on one clock:
//   - untouched for 7 days  -> warn the creator once
//   - untouched for 10 days -> archive, but never sooner than 3 days after
//     the warning, so a draft that is already old when the sweep first sees
//     it still gets its notice
//   - any edit after a warning clears the warning
// "Untouched" means no edit anywhere in the experiment — the row itself,
// its steps, characterizations, samples, or a comment.

export const IDLE_WARN_MS = 7 * 24 * 3_600_000;
export const IDLE_ARCHIVE_MS = 10 * 24 * 3_600_000;
export const IDLE_GRACE_MS = 3 * 24 * 3_600_000;

export type IdleDecision = "none" | "warn" | "reset" | "archive";

export function idleDecision(input: {
  now: Date;
  lastActivityAt: Date;
  warnedAt: Date | null;
}): IdleDecision {
  const { now, lastActivityAt, warnedAt } = input;
  if (warnedAt && lastActivityAt > warnedAt) return "reset";
  const idle = now.getTime() - lastActivityAt.getTime();
  if (warnedAt) {
    const sinceWarning = now.getTime() - warnedAt.getTime();
    return idle >= IDLE_ARCHIVE_MS && sinceWarning >= IDLE_GRACE_MS
      ? "archive"
      : "none";
  }
  return idle >= IDLE_WARN_MS ? "warn" : "none";
}
