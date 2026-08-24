"use client";

import { useState, useTransition } from "react";
import { useT } from "@/lib/i18n/LanguageProvider";
import { Icon } from "@/components/ui";
import { rematchNow, assignMeasurement, unassignMeasurement, type JvFileRow } from "@/lib/actions/instruments";

export type RigRow = {
  id: string;
  name: string;
  kind: string;
  hostname: string;
  agentVersion: string;
  watchDirs: string[];
  lastSeenLabel: string | null; // rendered server-side: freshness must not depend on render time
  fresh: boolean;
  lastError: string;
  uploads: number;
  measurements: number;
};

export type SampleOption = { id: string; label: string };

const fmt = (v: number | null, digits = 2) => (v == null ? "—" : v.toFixed(digits));

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded-[3px] bg-surface border border-line text-muted">
      {label} <span className="mono text-charcoal">{value}</span>
    </span>
  );
}

export function InstrumentsView({
  rigs,
  matched,
  unmatched,
  samples,
  canManage,
}: {
  rigs: RigRow[];
  matched: JvFileRow[];
  unmatched: JvFileRow[];
  samples: SampleOption[];
  canManage: boolean;
}) {
  const t = useT();
  const [pending, start] = useTransition();
  const [note, setNote] = useState("");
  const [tab, setTab] = useState<"unmatched" | "matched">(unmatched.length ? "unmatched" : "matched");
  const [assigning, setAssigning] = useState<string | null>(null);

  const rows = tab === "unmatched" ? unmatched : matched;

  return (
    <div className="space-y-5">
      {/* ── rigs ────────────────────────────────────────────────────────── */}
      <section>
        <h2 className="text-[12px] font-bold text-charcoal mb-2">{t("inst.rigs")}</h2>
        {rigs.length === 0 ? (
          <p className="text-xs text-muted border border-dashed border-line rounded-[6px] p-4 bg-surface">{t("inst.none")}</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {rigs.map((r) => {
              const fresh = r.fresh;
              return (
                <div key={r.id} className="border border-line rounded-[6px] p-3 bg-surface">
                  <div className="flex items-center gap-2">
                    <span className={"w-2 h-2 rounded-full shrink-0 " + (fresh ? "bg-brand" : "bg-line")} />
                    <h3 className="text-[12.5px] font-bold text-charcoal truncate">{r.name}</h3>
                    <span className="ml-auto text-[10px] text-muted shrink-0">
                      {fresh ? t("inst.online") : t("inst.offline")}
                    </span>
                  </div>
                  <dl className="mt-2 space-y-0.5 text-[11px] text-muted">
                    <div className="flex gap-2">
                      <dt className="w-20 shrink-0">{t("inst.lastSeen")}</dt>
                      <dd className="mono text-charcoal">{r.lastSeenLabel ?? t("inst.never")}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="w-20 shrink-0">{t("inst.host")}</dt>
                      <dd className="mono text-charcoal truncate">{r.hostname || "—"}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="w-20 shrink-0">{t("inst.watching")}</dt>
                      <dd className="mono text-charcoal truncate">{r.watchDirs.join("; ") || "—"}</dd>
                    </div>
                  </dl>
                  <div className="mt-2 flex flex-wrap gap-1">
                    <Metric label="files" value={String(r.uploads)} />
                    <Metric label="scans" value={String(r.measurements)} />
                    {r.agentVersion && <Metric label="agent" value={r.agentVersion} />}
                  </div>
                  {r.lastError && <p className="mt-2 text-[10.5px] text-warn">{r.lastError}</p>}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── inbox ───────────────────────────────────────────────────────── */}
      <section>
        <div className="flex items-center gap-2 mb-2">
          <h2 className="text-[12px] font-bold text-charcoal">{t("inst.inbox")}</h2>
          <div className="ml-auto flex items-center gap-1.5">
            {note && <span className="text-[10.5px] text-muted">{note}</span>}
            {canManage && (
              <button
                onClick={() =>
                  start(async () => {
                    const s = await rematchNow();
                    setNote(t("inst.rematchDone", { matched: String(s.matched), considered: String(s.considered) }));
                  })
                }
                disabled={pending}
                className="h-8 flex items-center gap-1 px-2.5 text-[11.5px] font-bold text-brand-deep border border-brand/40 bg-brand-soft rounded-[4px] disabled:opacity-50"
              >
                <Icon name="RefreshCw" size={13} /> {pending ? t("inst.rematching") : t("inst.rematch")}
              </button>
            )}
          </div>
        </div>

        <div className="flex gap-1 mb-2">
          {(["unmatched", "matched"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={
                "h-8 px-2.5 text-[11.5px] font-bold rounded-[4px] border " +
                (tab === k ? "bg-ink text-white border-ink" : "bg-surface text-muted border-line hover:border-charcoal/40")
              }
            >
              {k === "unmatched" ? t("inst.unmatched") : t("inst.matched")}
              <span className="ml-1.5 opacity-70">{k === "unmatched" ? unmatched.length : matched.length}</span>
            </button>
          ))}
        </div>

        <p className="text-[10.5px] text-muted mb-2">{t("inst.autoHint")}</p>

        {rows.length === 0 ? (
          <p className="text-xs text-muted border border-dashed border-line rounded-[6px] p-4 bg-surface">
            {tab === "unmatched" ? t("inst.emptyUnmatched") : t("inst.emptyInbox")}
          </p>
        ) : (
          <div className="border border-line rounded-[6px] bg-surface divide-y divide-line">
            {rows.map((f) => (
              <div key={f.id} className="p-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <div className="min-w-0">
                  <div className="text-[12px] font-bold text-charcoal mono truncate">{f.serial}</div>
                  <div className="text-[10.5px] text-muted truncate">
                    {f.instrument}
                    {f.measuredAt ? ` · ${f.measuredAt.slice(0, 16).replace("T", " ")}` : ""}
                    {f.direction ? ` · ${f.direction.toLowerCase()}` : ""}
                  </div>
                </div>
                <div className="flex flex-wrap gap-1">
                  <Metric label="PCE" value={fmt(f.pce)} />
                  <Metric label="Voc" value={fmt(f.voc, 4)} />
                  <Metric label="Jsc" value={fmt(f.jsc)} />
                  <Metric label="FF" value={fmt(f.ff)} />
                </div>
                {f.sampleCode ? (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-[3px] bg-brand-soft border border-brand/40 text-brand-deep font-bold">
                    {f.sampleCode}
                  </span>
                ) : (
                  <span className="text-[10.5px] text-warn max-w-full sm:max-w-80 truncate" title={f.matchNote}>
                    {f.matchNote}
                  </span>
                )}

                {canManage && (
                  <div className="ml-auto flex items-center gap-1.5">
                    {assigning === f.id ? (
                      <select
                        autoFocus
                        defaultValue=""
                        onChange={(e) => {
                          const sampleId = e.target.value;
                          if (!sampleId) return setAssigning(null);
                          start(async () => {
                            await assignMeasurement(f.id, sampleId);
                            setAssigning(null);
                            setNote(`${f.serial} → attached`);
                          });
                        }}
                        onBlur={() => setAssigning(null)}
                        className="h-8 text-[11.5px] border border-line rounded-[4px] px-1.5 bg-surface max-w-56"
                      >
                        <option value="">{t("inst.pickSample")}</option>
                        {samples.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <>
                        <button
                          onClick={() => setAssigning(f.id)}
                          disabled={pending}
                          className="h-8 px-2 text-[11px] font-bold text-brand-deep border border-brand/40 bg-brand-soft rounded-[4px] disabled:opacity-50"
                        >
                          {t("inst.assign")}
                        </button>
                        {f.sampleCode && (
                          <button
                            onClick={() => start(async () => {
                              await unassignMeasurement(f.id);
                              setNote(`${f.serial} → detached`);
                            })}
                            disabled={pending}
                            className="h-8 px-2 text-[11px] text-muted border border-line rounded-[4px] hover:border-charcoal/40 disabled:opacity-50"
                          >
                            {t("inst.detach")}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
