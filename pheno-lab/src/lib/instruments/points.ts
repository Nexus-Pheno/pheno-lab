/**
 * How many data points a stored curve holds.
 *
 * A data point is one (x, y) combination (Michael, 2026-09-16/19). A J-V
 * curve row carries the voltage and every quantity measured against it —
 * current, current density, power — so a row of {v, i, j, p} is three data
 * points: (V, I), (V, J), (V, P). The recount SQL in
 * modules/instruments/data-points-service.ts applies the same rule.
 */
export function curveDataPoints(curve: unknown): number {
  if (!Array.isArray(curve) || curve.length === 0) return 0;
  const first = curve[0];
  const fields =
    first && typeof first === "object"
      ? Object.keys(first as Record<string, unknown>).length
      : 0;
  return curve.length * Math.max(fields - 1, 0);
}
