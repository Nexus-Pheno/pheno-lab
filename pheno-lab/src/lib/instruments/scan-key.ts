import crypto from "crypto";
import type { JvScan } from "./types";
import { normalizeSerial } from "./normalize";

/**
 * Identifies one physical scan, independently of which file carried it.
 *
 * File-level SHA-256 is not enough: on the LIGHTSKY rig the operator ticks
 * "Select All" and saves at the end of every session, so session 2's file
 * legitimately re-contains session 1's traces. The bytes differ, the scans do
 * not. A unique index on (instrumentId, scanKey) makes the second copy a
 * no-op instead of a duplicate measurement.
 */
export function scanKeyOf(scan: JvScan): string {
  const m = scan.metrics;
  const first = scan.curve[0];
  const last = scan.curve[scan.curve.length - 1];
  const parts = [
    normalizeSerial(scan.serial),
    scan.direction ?? "",
    scan.condition ?? "",
    scan.measuredAt ? scan.measuredAt.toISOString() : "",
    m.pce ?? "",
    m.voc ?? "",
    m.jsc ?? "",
    scan.curve.length,
    // Guards the rare case of a scan with neither a timestamp nor metrics.
    first ? `${first.v}:${first.i}` : "",
    last ? `${last.v}:${last.i}` : "",
  ];
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex");
}
