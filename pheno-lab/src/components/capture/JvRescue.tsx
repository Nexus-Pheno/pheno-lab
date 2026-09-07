"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useT } from "@/lib/i18n/LanguageProvider";
import { Icon } from "@/components/ui";
import { canonicalSerialKey } from "@/lib/instruments/normalize";
import {
  assignMeasurement,
  pullJvFiles,
  type JvPullResult,
} from "@/lib/actions/instruments";
import type { SampleRow } from "@/lib/types";

// Same labels the instrument auto-fill writes — the card and the results page
// group values by these exact strings.
const scanMetrics = (f: {
  pce: number | null;
  voc: number | null;
  jsc: number | null;
  ff: number | null;
}): Record<string, string> => {
  const out: Record<string, string> = {};
  if (f.pce != null) out["PCE (%)"] = f.pce.toFixed(2);
  if (f.voc != null) out["Voc (V)"] = f.voc.toFixed(4);
  if (f.jsc != null) out["Jsc (mA/cm²)"] = f.jsc.toFixed(2);
  if (f.ff != null) out["FF (%)"] = f.ff.toFixed(2);
  return out;
};

function CandidateRow({
  f,
  samples,
  suggested,
  pending,
  onLink,
}: {
  f: { id: string; serial: string; pce: number | null; voc: number | null; jsc: number | null; ff: number | null };
  samples: SampleRow[];
  suggested: string | null;
  pending: boolean;
  onLink: (measurementId: string, sampleId: string, metrics: Record<string, string>) => void;
}) {
  const t = useT();
  const [sampleId, setSampleId] = useState(suggested ?? "");
  return (
    <div className="px-2 py-1.5 flex items-center gap-2 text-[11.5px]">
      <span className="mono font-bold text-charcoal truncate">{f.serial}</span>
      {f.pce != null && (
        <span className="mono text-muted shrink-0">{f.pce.toFixed(2)}%</span>
      )}
      <select
        value={sampleId}
        disabled={pending}
        onChange={(e) => setSampleId(e.target.value)}
        className="ml-auto h-8 text-[11.5px] border border-line rounded-[4px] px-1 bg-surface shrink-0 max-w-28"
      >
        <option value="">{t("jvr.pick")}</option>
        {samples.map((s) => (
          <option key={s.id} value={s.id}>
            {s.code}
            {s.simCode ? ` · ${s.simCode}` : ""}
            {s.id === suggested ? ` (${t("jvr.suggested")})` : ""}
          </option>
        ))}
      </select>
      <button
        disabled={pending || !sampleId}
        onClick={() => onLink(f.id, sampleId, scanMetrics(f))}
        className="h-8 shrink-0 px-2.5 text-[11.5px] font-bold text-brand-deep border border-brand/40 bg-brand-soft rounded-[4px] disabled:opacity-40"
      >
        {t("jvr.link")}
      </button>
    </div>
  );
}

/**
 * The repair path for a mistyped sample ID, shown where technicians actually
 * work: the capture card. Loading the card sweeps the unmatched queue (which
 * now forgives extra zeros on its own), and whatever still cannot be explained
 * is offered here for one-tap linking — 2026-09-04's D group sat broken for
 * days because the only repair UI lived in the desktop designer.
 */
export function JvRescue({
  experimentId,
  expCode,
  samples,
  onLinked,
}: {
  experimentId: string;
  expCode: string;
  samples: SampleRow[];
  onLinked: (sampleId: string, metrics: Record<string, string>) => void;
}) {
  const t = useT();
  const [data, setData] = useState<JvPullResult | null>(null);
  const [open, setOpen] = useState(false);
  const [showOthers, setShowOthers] = useState(false);
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();

  const load = () =>
    start(async () => {
      try {
        setData(await pullJvFiles(experimentId));
      } catch {
        // The card must not break when the sweep fails; retry on next mount.
      }
    });

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [experimentId]);

  // Which sample could this serial mean? Zero-insensitive, whole segments only.
  const suggestFor = useMemo(() => {
    const forms = samples.map((s) => ({
      id: s.id,
      keys: [
        ...(s.simCode ? [s.simCode] : []),
        `${expCode}-${s.code}`,
        ...(s.instrumentCodes ?? []),
      ].map(canonicalSerialKey),
    }));
    return (serial: string): string | null => {
      const key = canonicalSerialKey(serial);
      const hits = forms.filter((f) =>
        f.keys.some((k) => k && (key === k || key.startsWith(k + "-"))),
      );
      return hits.length === 1 ? hits[0].id : null;
    };
  }, [samples, expCode]);

  const candidates = data?.candidates ?? [];
  const plausible = candidates.filter((f) => suggestFor(f.serial));
  const others = candidates.filter((f) => !suggestFor(f.serial));
  if (!candidates.length) return null;

  const link = (measurementId: string, sampleId: string, metrics: Record<string, string>) =>
    start(async () => {
      try {
        await assignMeasurement(measurementId, sampleId);
        onLinked(sampleId, metrics);
        setNote(t("jvr.linked"));
        setData(await pullJvFiles(experimentId));
      } catch (err) {
        setNote((err as Error).message);
      }
    });

  return (
    <div className="mb-3 border border-warn/40 bg-warn/5 rounded-[6px] overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full px-2.5 py-2 flex items-center gap-1.5 text-left"
      >
        <Icon name="Unlink" size={13} className="text-warn shrink-0" />
        <span className="text-[11.5px] font-semibold text-charcoal flex-1">
          {t("jvr.unlinked", { n: String(candidates.length) })}
        </span>
        <Icon name={open ? "ChevronUp" : "ChevronDown"} size={13} className="text-muted shrink-0" />
      </button>
      {open && (
        <div className="border-t border-warn/30">
          <p className="text-[10.5px] text-muted px-2.5 pt-1.5">{t("jvr.hint")}</p>
          {note && <p className="text-[10.5px] text-brand-deep px-2.5 pt-1">{note}</p>}
          {plausible.length > 0 && (
            <div className="divide-y divide-line mt-1">
              {plausible.map((f) => (
                <CandidateRow
                  key={f.id}
                  f={f}
                  samples={samples}
                  suggested={suggestFor(f.serial)}
                  pending={pending}
                  onLink={link}
                />
              ))}
            </div>
          )}
          {others.length > 0 && (
            <div className="pb-1.5">
              <button
                onClick={() => setShowOthers((v) => !v)}
                className="text-[10.5px] text-muted hover:text-charcoal flex items-center gap-1 px-2.5 pt-1.5"
              >
                <Icon name={showOthers ? "ChevronDown" : "ChevronRight"} size={11} />
                {t("jvr.others")} ({others.length})
              </button>
              {showOthers && (
                <div className="divide-y divide-line mt-1">
                  {others.map((f) => (
                    <CandidateRow
                      key={f.id}
                      f={f}
                      samples={samples}
                      suggested={null}
                      pending={pending}
                      onLink={link}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
