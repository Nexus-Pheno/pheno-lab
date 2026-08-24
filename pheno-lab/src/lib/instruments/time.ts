/**
 * Instrument files record LOCAL wall-clock time with no timezone. The lab is in
 * Shenzhen (UTC+8) but the Tencent Cloud server may well run UTC, so every
 * timestamp must be anchored explicitly or measurements land 8 hours off.
 */
export const LAB_TZ_OFFSET_MINUTES = 8 * 60;

export function wallClockToDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  tzOffsetMinutes: number,
): Date {
  return new Date(
    Date.UTC(year, month - 1, day, hour, minute, second) -
      tzOffsetMinutes * 60_000,
  );
}

/** Wall-clock Y/M/D at the given offset, used to date time-only records. */
export function wallClockParts(d: Date, tzOffsetMinutes: number) {
  const shifted = new Date(d.getTime() + tzOffsetMinutes * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** "20260820" (folder names on the GiantForce PC) → Y/M/D, or null. */
export function parseDateFolder(
  name: string,
): { year: number; month: number; day: number } | null {
  const m = name.match(/(20\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}
