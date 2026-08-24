"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useT } from "@/lib/i18n/LanguageProvider";
import { Icon } from "@/components/ui";
import { assignMeasurement, pullJvFiles, setSampleAliases, type JvPullResult } from "@/lib/actions/instruments";

const fmt = (v: number | null, digits = 2) => (v == null ? "—" : v.toFixed(digits));

/**
 * The J-V side of an experiment: which samples already have instrument files,
 * what is attached, and a manual pull for the impatient. Files normally arrive
 * on their own — this panel exists so a person can see that they did, and fix
 * the case where an operator mistyped a serial.
 */
export function JvFilesPanel({ experimentId, experimentCode }: { experimentId: string; experimentCode: string }) {
  const t = useT();
  const [data, setData] = useState<JvPullResult | null>(null);
  const [note, setNote] = useState("");
  const [showCandidates, setShowCandidates] = useState(false);
  const [showSerials, setShowSerials] = useState(false);
  const [copied, setCopied] = useState(false);
  const [aliasFor, setAliasFor] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const pull = useCallback(
    (announce: boolean) =>
      start(async () => {
        const result = await pullJvFiles(experimentId);
        setData(result);
        if (announce) {
          setNote(
            t("jv.pulled", { matched: String(result.summary.matched), files: String(result.files.length) }),
          );
        }
      }),
    [experimentId, t],
  );

  // Refresh on open so the panel always reflects what has arrived since.
  useEffect(() => {
    pull(false);
  }, [pull]);

  const samples = data?.samples ?? [];
  const withFiles = samples.filter((s) => s.scans > 0).length;

  return (
    <section className="border-t border-line pt-3 mt-3">
      <div className="flex items-center gap-2 mb-2">
        <h3 className="text-[12px] font-bold text-charcoal flex items-center gap-1.5">
          <Icon name="Radio" size={13} className="text-brand-deep" /> {t("jv.title")}
        </h3>
        <button
          onClick={() => pull(true)}
          disabled={pending}
          className="ml-auto h-8 flex items-center gap-1 px-2.5 text-[11.5px] font-bold text-brand-deep border border-brand/40 bg-brand-soft rounded-[4px] disabled:opacity-50"
        >
          <Icon name="RefreshCw" size={13} /> {pending ? t("jv.pulling") : t("jv.pull")}
        </button>
      </div>

      {note && <p className="text-[10.5px] text-muted mb-2">{note}</p>}

      {/* Sample roll-call — the answer to "did S3's file arrive?" */}
      {samples.length > 0 && (
        <>
          <div className="text-[10.5px] text-muted mb-1">
            {t("jv.samples")} · {withFiles}/{samples.length}
          </div>
          <div className="flex flex-wrap gap-1 mb-2">
            {samples.map((s) => (
              <span
                key={s.id}
                title={
                  s.scans
                    ? `${s.scans === 1 ? t("jv.scansOne") : t("jv.scansMany", { n: String(s.scans) })}` +
                      (s.pce != null ? ` · ${t("jv.best")} ${s.pce.toFixed(2)}%` : "")
                    : t("jv.noScans")
                }
                className={
                  "text-[10.5px] px-1.5 py-0.5 rounded-[3px] border font-bold flex items-center gap-1 " +
                  (s.scans
                    ? "bg-brand-soft border-brand/40 text-brand-deep"
                    : "bg-surface border-line text-muted")
                }
              >
                {s.scans > 0 && <Icon name="Check" size={11} />}
                {s.code}
                {s.pce != null && <span className="mono font-normal opacity-80">{s.pce.toFixed(1)}%</span>}
              </span>
            ))}
          </div>
        </>
      )}

      {/* What the operator has to type on the instrument */}
      {samples.length > 0 && (
        <div className="mb-2">
          <button
            onClick={() => setShowSerials((v) => !v)}
            className="text-[11px] text-muted hover:text-charcoal flex items-center gap-1"
          >
            <Icon name={showSerials ? "ChevronDown" : "ChevronRight"} size={12} />
            {t("jv.serials")}
          </button>
          {showSerials && (
            <>
              <div className="flex items-center gap-2 mt-1 mb-1">
                <p className="text-[10.5px] text-muted flex-1">
                  {t("jv.serialsHint", { example: samples[0]?.serial || "E1-S1" })}
                </p>
                <button
                  onClick={() => {
                    void navigator.clipboard.writeText(samples.map((s) => s.serial).join("\n"));
                    setCopied(true);
                  }}
                  className="h-7 shrink-0 flex items-center gap-1 px-2 text-[11px] font-bold text-brand-deep border border-brand/40 bg-brand-soft rounded-[4px]"
                >
                  <Icon name={copied ? "Check" : "Copy"} size={12} /> {copied ? t("jv.copied") : t("jv.copyAll")}
                </button>
              </div>
              <div className="border border-line rounded-[6px] bg-surface divide-y divide-line max-h-56 overflow-y-auto">
                {samples.map((s) => (
                  <div key={s.id} className="px-2 py-1.5 flex items-center gap-2 text-[11px]">
                    <span className="text-muted w-8 shrink-0">{s.code}</span>
                    <span className="mono font-bold text-charcoal">{s.serial}</span>
                    {s.aliases.length > 0 && (
                      <span className="text-[10.5px] text-muted truncate">
                        {t("jv.alias")} <span className="mono">{s.aliases.join(", ")}</span>
                      </span>
                    )}
                    {aliasFor === s.id ? (
                      <input
                        autoFocus
                        placeholder={t("jv.aliasAdd")}
                        disabled={pending}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") return setAliasFor(null);
                          if (e.key !== "Enter") return;
                          const value = e.currentTarget.value.trim();
                          if (!value) return setAliasFor(null);
                          start(async () => {
                            try {
                              await setSampleAliases(s.id, [...s.aliases, value]);
                              setNote(t("jv.aliasSaved"));
                              setAliasFor(null);
                              const result = await pullJvFiles(experimentId);
                              setData(result);
                            } catch (err) {
                              setNote((err as Error).message);
                            }
                          });
                        }}
                        onBlur={() => setAliasFor(null)}
                        className="ml-auto h-7 w-40 text-[11px] border border-line rounded-[4px] px-1.5 bg-surface"
                      />
                    ) : (
                      <button
                        onClick={() => setAliasFor(s.id)}
                        title={t("jv.aliasAdd")}
                        className="ml-auto h-7 w-7 shrink-0 flex items-center justify-center text-muted border border-line rounded-[4px] hover:border-charcoal/40"
                      >
                        <Icon name="Plus" size={12} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {data && data.files.length === 0 && (
        <p className="text-[11px] text-muted border border-dashed border-line rounded-[6px] p-3 bg-surface">
          {t("jv.noneYet")}
        </p>
      )}

      {/* Attached files */}
      {data && data.files.length > 0 && (
        <div className="border border-line rounded-[6px] bg-surface divide-y divide-line max-h-56 overflow-y-auto">
          {data.files.map((f) => (
            <div key={f.id} className="px-2 py-1.5 flex items-center gap-2 text-[11px]">
              <span className="font-bold text-brand-deep shrink-0">{f.sampleCode}</span>
              <span className="mono text-muted truncate">{f.serial}</span>
              <span className="ml-auto flex gap-1.5 shrink-0 mono text-charcoal">
                <span>{fmt(f.pce)}%</span>
                <span className="text-muted">{f.direction?.slice(0, 3).toLowerCase()}</span>
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Mistyped serials: attach by hand */}
      {data && data.candidates.length > 0 && (
        <div className="mt-2">
          <button
            onClick={() => setShowCandidates((v) => !v)}
            className="text-[11px] text-muted hover:text-charcoal flex items-center gap-1"
          >
            <Icon name={showCandidates ? "ChevronDown" : "ChevronRight"} size={12} />
            {t("jv.candidates")} ({data.candidates.length})
          </button>
          {showCandidates && (
            <>
              <p className="text-[10.5px] text-muted mt-1 mb-1">{t("jv.candidatesHint")}</p>
              <div className="border border-line rounded-[6px] bg-surface divide-y divide-line max-h-48 overflow-y-auto">
                {data.candidates.map((f) => (
                  <div key={f.id} className="px-2 py-1.5 flex items-center gap-2 text-[11px]">
                    <span className="mono text-charcoal truncate">{f.serial}</span>
                    <span className="text-muted shrink-0">{fmt(f.pce)}%</span>
                    <select
                      defaultValue=""
                      disabled={pending}
                      onChange={(e) => {
                        const sampleId = e.target.value;
                        if (!sampleId) return;
                        start(async () => {
                          await assignMeasurement(f.id, sampleId);
                          const result = await pullJvFiles(experimentId);
                          setData(result);
                          setNote(`${f.serial} → ${samples.find((s) => s.id === sampleId)?.code ?? ""}`);
                        });
                      }}
                      className="ml-auto h-7 text-[11px] border border-line rounded-[4px] px-1 bg-surface shrink-0"
                    >
                      <option value="">{t("jv.attach")}…</option>
                      {samples.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.code}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      <p className="text-[10.5px] text-muted mt-2">{t("jv.hint", { example: `${experimentCode}-S1` })}</p>
    </section>
  );
}
