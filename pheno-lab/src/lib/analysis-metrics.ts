/** Metric keys, safe for client components (no server-only imports). */
export const METRICS = ["pce", "voc", "jsc", "ff"] as const;
export type MetricKey = (typeof METRICS)[number];

/** "PCE (%)" → pce, "Voc (V)" → voc — result rows label their metrics. */
export const metricKeyOf = (label: string): MetricKey | null => {
  if (/pce|efficiency|^eff/i.test(label)) return "pce";
  if (/voc/i.test(label)) return "voc";
  if (/jsc/i.test(label)) return "jsc";
  if (/^ff|fill/i.test(label)) return "ff";
  return null;
};
