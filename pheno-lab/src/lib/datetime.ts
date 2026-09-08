// The lab runs on one clock: Beijing (UTC+8). The database stores UTC;
// everything a person reads goes through here (Tyler's feedback, 2026-09-08).
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/** "2026-09-08 14:30" (minute) or "2026-09-08" (date) in Beijing time. */
export function fmtBeijing(
  date: Date,
  style: "minute" | "date" = "minute",
): string {
  const iso = new Date(date.getTime() + BEIJING_OFFSET_MS).toISOString();
  return style === "date"
    ? iso.slice(0, 10)
    : iso.replace("T", " ").slice(0, 16);
}
