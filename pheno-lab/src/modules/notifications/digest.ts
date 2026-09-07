export function digestWindow(now: Date) {
  const date = new Date(now.getTime() + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const end = new Date(`${date}T00:00:00+08:00`);
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  return { date, start, end };
}

export function championPce(
  measurements: Array<{ metrics: unknown }>,
): number | null {
  const values = measurements.flatMap(({ metrics }) => {
    if (!metrics || typeof metrics !== "object" || !("pce" in metrics))
      return [];
    const value = metrics.pce;
    return typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 100
      ? [value]
      : [];
  });
  return values.length
    ? values.reduce((best, value) => Math.max(best, value))
    : null;
}
