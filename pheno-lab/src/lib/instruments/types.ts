// Shared shapes for instrument file parsing. Every connector normalizes into
// these units so downstream code never has to know which rig produced a scan:
//   voc V · isc mA · jsc mA/cm² · pmax mW · vmax V · imax mA · pce % · ff % · rs/rsh Ω · area cm²
// Current sign is normalized to the GiantForce convention: photocurrent is
// POSITIVE at 0 V and crosses zero at Voc.

export type InstrumentKind = "GIANTFORCE_IV" | "LIGHTSKY_LIV";

export type ScanDirection = "FORWARD" | "REVERSE";
export type TestCondition = "LIGHT" | "DARK";

export type JvMetrics = {
  voc?: number;
  isc?: number;
  jsc?: number;
  pmax?: number;
  vmax?: number;
  imax?: number;
  pce?: number;
  ff?: number;
  rs?: number;
  rsh?: number;
  area?: number;
};

export type CurvePoint = { v: number; i: number; p?: number; j?: number };

export type JvScan = {
  /** Exactly as the operator typed it into the instrument software. */
  serial: string;
  direction: ScanDirection | null;
  condition: TestCondition | null;
  measuredAt: Date | null;
  operator: string;
  material: string;
  metrics: JvMetrics;
  curve: CurvePoint[];
  /** Scan setup as reported by the software (start/stop V, points, mode...). */
  settings: Record<string, string | number | boolean>;
};

export type ParsedJvFile = {
  instrument: InstrumentKind;
  scans: JvScan[];
  warnings: string[];
};

/** Thrown for files we deliberately refuse (wrong format, no curve, binary). */
export class UnsupportedInstrumentFile extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedInstrumentFile";
  }
}
