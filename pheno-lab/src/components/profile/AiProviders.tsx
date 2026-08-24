"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  saveAiProvider, setActiveAiProvider, deleteAiProvider, testAiProvider, fetchAvailableModels,
  type AiProviderRow,
} from "@/lib/actions/ai";
import { PROVIDER_PRESETS } from "@/lib/ai/presets";
import { useT } from "@/lib/i18n/LanguageProvider";
import { Icon, FieldLabel, inputCls } from "@/components/ui";

/** Admin-only: configure which LLM the organization uses, and switch models. */
export function AiProviders({ rows }: { rows: AiProviderRow[] }) {
  const t = useT();
  const router = useRouter();
  const [editing, setEditing] = useState<AiProviderRow | "new" | null>(null);
  const [busy, setBusy] = useState("");
  const [confirmDel, setConfirmDel] = useState<string | null>(null);

  return (
    <div className="bg-surface border border-line rounded-[6px] p-3.5 space-y-3">
      <div className="flex items-center gap-2">
        <Icon name="Sparkles" size={15} className="text-brand-deep" />
        <div className="flex-1 min-w-0">
          <h2 className="text-[13px] font-bold">{t("ai.title")}</h2>
          <p className="text-[11px] text-muted">{t("ai.subtitle")}</p>
        </div>
        {!editing && (
          <button
            onClick={() => setEditing("new")}
            className="h-8 px-3 bg-brand text-[#243000] rounded-[4px] text-[12px] font-bold flex items-center gap-1.5"
          >
            <Icon name="Plus" size={13} /> {t("ai.add")}
          </button>
        )}
      </div>

      {rows.length === 0 && !editing && (
        <p className="text-[11.5px] text-warn bg-warn-soft border border-warn-line rounded-[4px] px-2.5 py-1.5">
          {t("ai.empty")}
        </p>
      )}

      {rows.length > 0 && (
        <div className="border border-line rounded-[4px] divide-y divide-line">
          {rows.map((r) => (
            <div key={r.id} className="px-2.5 py-2 flex flex-wrap items-center gap-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  {r.active && (
                    <span className="text-[9px] font-bold uppercase px-1 py-0.5 rounded-[3px] bg-brand-soft text-brand-deep border border-brand/40">
                      {t("ai.active")}
                    </span>
                  )}
                  <span className="text-[12.5px] font-semibold truncate">{r.label}</span>
                  <span className="mono text-[10.5px] text-muted truncate">{r.model}</span>
                </div>
                <div className="text-[10px] text-muted mono truncate">
                  {r.keyHint} · {r.baseUrl}
                  {" · "}
                  {r.lastStatus ? `${r.lastStatus} (${r.lastCheckedAt})` : t("ai.never")}
                </div>
              </div>
              {!r.active && (
                <button
                  onClick={async () => { setBusy(r.id); await setActiveAiProvider(r.id); setBusy(""); router.refresh(); }}
                  className="h-7 px-2 border border-line rounded-[4px] text-[11px] font-semibold hover:bg-subtle"
                >
                  {t("ai.use")}
                </button>
              )}
              <button
                disabled={busy === r.id}
                onClick={async () => { setBusy(r.id); await testAiProvider(r.id); setBusy(""); router.refresh(); }}
                className="h-7 px-2 border border-line rounded-[4px] text-[11px] font-semibold hover:bg-subtle"
              >
                {busy === r.id ? t("ai.testing") : t("ai.test")}
              </button>
              <button onClick={() => setEditing(r)} className="p-1 text-muted hover:text-ink">
                <Icon name="Pencil" size={13} />
              </button>
              {confirmDel === r.id ? (
                <span className="flex items-center gap-1 bg-warn-soft border border-warn-line rounded-[4px] px-1.5 py-0.5">
                  <span className="text-[10.5px] font-semibold text-warn">{t("ai.removeQ")}</span>
                  <button
                    onClick={async () => { await deleteAiProvider(r.id); setConfirmDel(null); router.refresh(); }}
                    className="p-0.5 text-danger"
                  >
                    <Icon name="Check" size={12} />
                  </button>
                  <button onClick={() => setConfirmDel(null)} className="p-0.5 text-muted">
                    <Icon name="X" size={12} />
                  </button>
                </span>
              ) : (
                <button onClick={() => setConfirmDel(r.id)} className="p-1 text-muted hover:text-danger">
                  <Icon name="Trash2" size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {editing && <ProviderForm row={editing === "new" ? null : editing} onDone={() => { setEditing(null); router.refresh(); }} />}
    </div>
  );
}

function ProviderForm({ row, onDone }: { row: AiProviderRow | null; onDone: () => void }) {
  const t = useT();
  const preset = PROVIDER_PRESETS.find((p) => p.id === (row?.provider ?? "deepseek")) ?? PROVIDER_PRESETS[0];
  const [provider, setProvider] = useState(row?.provider ?? "deepseek");
  const [label, setLabel] = useState(row?.label ?? preset.label);
  const [baseUrl, setBaseUrl] = useState(row?.baseUrl ?? preset.baseUrl);
  const [model, setModel] = useState(row?.model ?? preset.models[0] ?? "");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // Models offered by the provider right now — always beats a hardcoded list.
  const [live, setLive] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);

  const loadModels = async () => {
    setLoadingModels(true);
    setErr("");
    try {
      const r = await fetchAvailableModels({ id: row?.id, baseUrl, apiKey });
      setLive(r.models);
      if (r.error) setErr(r.error);
      if (r.models.length && !r.models.includes(model)) setModel(r.models[0]);
    } finally {
      setLoadingModels(false);
    }
  };

  const pickProvider = (id: string) => {
    setProvider(id);
    const p = PROVIDER_PRESETS.find((x) => x.id === id);
    if (p && !row) {
      setLabel(p.label);
      setBaseUrl(p.baseUrl);
      setModel(p.models[0] ?? "");
    }
  };

  return (
    <div className="border border-line rounded-[4px] p-2.5 space-y-2.5 bg-subtle">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        <div>
          <FieldLabel>{t("ai.provider")}</FieldLabel>
          <select
            value={provider}
            onChange={(e) => pickProvider(e.target.value)}
            className="h-9 w-full border border-line rounded-[4px] px-2 text-[12.5px] bg-surface"
          >
            {PROVIDER_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </div>
        <div>
          <FieldLabel>{t("ai.label")}</FieldLabel>
          <input className={inputCls} value={label} onChange={(e) => setLabel(e.target.value)} />
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        <div>
          <FieldLabel>{t("ai.baseUrl")}</FieldLabel>
          <input className={inputCls + " mono"} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </div>
        <div>
          <FieldLabel>{t("ai.model")}</FieldLabel>
          <div className="flex gap-1.5">
            {live.length > 0 ? (
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="h-9 flex-1 min-w-0 border border-line rounded-[4px] px-2 text-[12.5px] mono bg-surface"
              >
                {live.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            ) : (
              <input
                className={inputCls + " mono flex-1 min-w-0"}
                value={model}
                onChange={(e) => setModel(e.target.value)}
                list="ai-models"
              />
            )}
            <button
              type="button"
              disabled={loadingModels}
              onClick={loadModels}
              className="h-9 px-2.5 border border-line rounded-[4px] text-[11.5px] font-semibold bg-surface whitespace-nowrap disabled:opacity-50"
            >
              {loadingModels ? t("ai.loading") : t("ai.loadModels")}
            </button>
          </div>
          <datalist id="ai-models">
            {(PROVIDER_PRESETS.find((p) => p.id === provider)?.models ?? []).map((m) => <option key={m} value={m} />)}
          </datalist>
          <p className="text-[10px] text-muted mt-1">
            {live.length > 0 ? t("ai.liveModels").replace("{n}", String(live.length)) : t("ai.modelHint")}
          </p>
        </div>
      </div>
      <div>
        <FieldLabel>{t("ai.key")}</FieldLabel>
        <input
          type="password"
          autoComplete="off"
          className={inputCls + " mono"}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={row ? t("ai.keyKeep") : "sk-…"}
        />
      </div>
      {err && <p className="text-[11.5px] text-danger">{err}</p>}
      <div className="flex items-center gap-2">
        <span className="flex-1" />
        <button onClick={onDone} className="h-8 px-3 border border-line rounded-[4px] text-[12px] font-semibold bg-surface">
          {t("ai.cancel")}
        </button>
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true); setErr("");
            try {
              await saveAiProvider({ id: row?.id, label, provider, baseUrl, model, apiKey });
              onDone();
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
          className="h-8 px-3.5 bg-brand text-[#243000] rounded-[4px] text-[12px] font-bold disabled:opacity-50"
        >
          {t("ai.save")}
        </button>
      </div>
    </div>
  );
}
