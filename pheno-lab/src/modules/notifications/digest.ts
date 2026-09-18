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

export type ChampionScan = {
  pce: number;
  /** Experiment code the scan belongs to. */
  code: string;
  /** Who ran it: the assignee if one was named, else the creator. */
  who: string;
};

/**
 * The best valid light scan of the day and who ran it. "Who" is the person
 * responsible for the experiment (assignee, else creator) — the operator
 * typed on the instrument PC is free text and often a shared login.
 */
export function championScan(
  measurements: Array<{
    metrics: unknown;
    experiment: {
      code: string;
      createdBy: { name: string };
      assignee: { name: string } | null;
    } | null;
  }>,
): ChampionScan | null {
  let best: ChampionScan | null = null;
  for (const { metrics, experiment } of measurements) {
    if (!metrics || typeof metrics !== "object" || !("pce" in metrics))
      continue;
    const value = (metrics as { pce: unknown }).pce;
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 100
    )
      continue;
    if (best && value <= best.pce) continue;
    best = {
      pce: value,
      code: experiment?.code ?? "",
      who: experiment?.assignee?.name ?? experiment?.createdBy.name ?? "",
    };
  }
  return best;
}

/** "Lily 3、Dennis 2、Joey 1" — busiest first, ties by name. */
export function activityLine(
  rows: Array<{ name: string; experiments: number }>,
): string {
  if (rows.length === 0) return "暂无";
  return [...rows]
    .sort(
      (a, b) => b.experiments - a.experiments || a.name.localeCompare(b.name),
    )
    .map((r) => `${r.name} ${r.experiments}`)
    .join("、");
}
