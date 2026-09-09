/** Metric keys, safe for client components (no server-only imports). */
export const METRICS = ["pce", "voc", "jsc", "ff"] as const;
export type MetricKey = (typeof METRICS)[number];
