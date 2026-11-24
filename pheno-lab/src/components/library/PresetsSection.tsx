"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type {
  PresetRow,
  PresetReviewRow,
  PresetErrorCode,
} from "@/modules/experiments/preset-policy";
import {
  updatePreset,
  deletePreset,
  submitPreset,
  reviewPreset,
  createPresetDraft,
} from "@/lib/actions/experiments";
import { useT } from "@/lib/i18n/LanguageProvider";
import { inputCls } from "@/components/ui";
import {
  PresetEditor,
  PresetSummary,
  type PresetEditorCatalog,
} from "./PresetEditor";

export function PresetsSection({
  presets,
  personalPresets,
  rows,
  canReview,
  catalog,
}: {
  presets: PresetRow[];
  personalPresets: PresetRow[];
  rows: PresetReviewRow[];
  canReview: boolean;
  catalog: PresetEditorCatalog;
}) {
  const t = useT();
  const router = useRouter();
  const [tab, setTab] = useState<"PUBLIC" | "PERSONAL" | "REVIEW">("PUBLIC");
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PresetErrorCode | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const run = async (
    op: () => Promise<
      { ok: true; value: unknown } | { ok: false; error: PresetErrorCode }
    >,
  ) => {
    setBusy(true);
    setError(null);
    try {
      const result = await op();
      if (!result.ok) {
        setError(result.error);
        return false;
      }
      setEditing(null);
      setDeleting(null);
      router.refresh();
      return true;
    } catch {
      setError("invalid");
      return false;
    } finally {
      setBusy(false);
    }
  };
  const visible = tab === "PUBLIC" ? presets : personalPresets;
  return (
    <section
      id="presets"
      className="scroll-mt-4 border border-line rounded-md bg-surface p-4 space-y-4"
    >
      <h2 className="text-lg font-bold">{t("lib.presets")}</h2>
      <p className="text-sm text-muted">{t("presets.hint")}</p>
      <div
        role="tablist"
        aria-label={t("lib.presets")}
        className="flex flex-wrap gap-2"
      >
        {(["PUBLIC", "PERSONAL", "REVIEW"] as const).map((key) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => {
              setTab(key);
              setEditing(null);
              setDeleting(null);
              setError(null);
            }}
            className={`rounded border px-3 py-2 text-sm ${tab === key ? "bg-ink text-white" : "border-line"}`}
          >
            {t(
              key === "PUBLIC"
                ? "presets.public"
                : key === "PERSONAL"
                  ? "presets.personal"
                  : "presets.reviews",
            )}{" "}
            (
            {key === "PUBLIC"
              ? presets.length
              : key === "PERSONAL"
                ? personalPresets.length
                : rows.length}
            )
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {t(`presets.error.${error}`)}
        </p>
      )}
      {tab !== "REVIEW" ? (
        <div role="tabpanel" className="space-y-3">
          {!visible.length && (
            <p className="text-sm text-muted">{t("lib.noPresets")}</p>
          )}
          {visible.map((p) => (
            <article
              key={p.id}
              data-preset-id={p.id}
              className="border border-line rounded p-3 space-y-3 min-w-0 [overflow-wrap:anywhere]"
            >
              <div>
                <h3 className="font-semibold">{p.name}</h3>
                <p className="text-xs text-muted">
                  {p.process.name} ·{" "}
                  {t(p.kind === "STEP" ? "lib.stepKind" : "lib.charKind")} ·{" "}
                  {p.createdBy?.name ?? "—"}
                </p>
                {p.scope === "PERSONAL" && (
                  <p className="text-xs text-brand-deep mt-1">
                    {t(
                      p.publicPresetId
                        ? "presets.linked"
                        : "presets.privateOnly",
                    )}{" "}
                    {p.publicationStatus &&
                      t(`presets.status.${p.publicationStatus}`)}
                    {p.hasUnpublishedChanges &&
                      ` · ${t("presets.unpublishedChanges")}`}
                  </p>
                )}
              </div>
              <details>
                <summary className="cursor-pointer text-sm">
                  {t("presets.details")}
                </summary>
                <div className="mt-3">
                  <PresetSummary
                    kind={p.kind}
                    payload={p.payload}
                    catalog={catalog}
                  />
                </div>
              </details>
              <div className="flex flex-wrap gap-3 text-sm">
                {p.canEdit && (
                  <button
                    disabled={busy}
                    onClick={() => setEditing(editing === p.id ? null : p.id)}
                    className="text-brand-deep font-semibold"
                  >
                    {t("presets.edit")}
                  </button>
                )}
                {p.canDelete && (
                  <button
                    disabled={busy}
                    onClick={() => setDeleting(p.id)}
                    className="text-danger"
                  >
                    {t("presets.delete")}
                  </button>
                )}
                {p.canSubmit && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(() => submitPreset(p.id, p.revision))
                    }
                    className="text-brand-deep"
                  >
                    {t("presets.submit")}
                  </button>
                )}
                {p.canDraft && (
                  <button
                    disabled={busy}
                    onClick={async () => {
                      if (await run(() => createPresetDraft(p.id)))
                        setTab("PERSONAL");
                    }}
                    className="text-brand-deep"
                  >
                    {t("presets.draft")}
                  </button>
                )}
              </div>
              {deleting === p.id && (
                <div
                  role="alert"
                  className="border border-line rounded p-3 text-sm space-y-2"
                >
                  <p>
                    {t(
                      p.scope === "PUBLIC"
                        ? "presets.deletePublicHint"
                        : "presets.deletePersonalHint",
                    )}
                  </p>
                  <div className="flex gap-4">
                    <button
                      disabled={busy}
                      onClick={() =>
                        void run(() => deletePreset(p.id, p.revision))
                      }
                      className="font-bold text-danger"
                    >
                      {t("presets.confirmDelete")}
                    </button>
                    <button disabled={busy} onClick={() => setDeleting(null)}>
                      {t("lib.cancel")}
                    </button>
                  </div>
                </div>
              )}
              {editing === p.id && (
                <PresetEditor
                  key={`${p.id}:${p.revision}`}
                  preset={p}
                  catalog={catalog}
                  busy={busy}
                  onCancel={() => setEditing(null)}
                  onSave={(name, payload) =>
                    run(() => updatePreset(p.id, { name, payload }, p.revision))
                  }
                />
              )}
            </article>
          ))}
        </div>
      ) : (
        <div role="tabpanel" className="space-y-3">
          <p className="text-xs text-muted">
            {t(canReview ? "presets.queueHint" : "presets.historyHint")}
          </p>
          {!rows.length && (
            <p className="text-sm text-muted">{t("presets.noReviews")}</p>
          )}
          {rows.map((r) => (
            <article
              key={r.id}
              data-preset-review-id={r.id}
              className="border border-line rounded p-3 space-y-3 min-w-0 [overflow-wrap:anywhere]"
            >
              <h3 className="font-semibold">
                {r.name} · {r.author} · {t(`presets.status.${r.status}`)}
              </h3>
              <p className="text-xs text-muted">
                {catalog.processes.find((p) => p.id === r.processId)?.name ??
                  "—"}{" "}
                · {t(r.kind === "STEP" ? "lib.stepKind" : "lib.charKind")}
              </p>
              {r.reason && (
                <p className="text-sm whitespace-pre-wrap">{r.reason}</p>
              )}
              <details>
                <summary className="cursor-pointer text-sm">
                  {t("presets.reviewDetails")}
                </summary>
                <div className="grid md:grid-cols-2 gap-4 mt-3">
                  <div>
                    <h4 className="font-semibold text-sm mb-2">
                      {t("presets.currentPublic")}
                    </h4>
                    {r.base ? (
                      <>
                        <p className="text-sm mb-2">
                          {(r.base as { name: string }).name}
                        </p>
                        <PresetSummary
                          kind={r.kind}
                          payload={(r.base as { payload: unknown }).payload}
                          catalog={catalog}
                        />
                      </>
                    ) : (
                      <p className="text-sm text-muted">
                        {t("presets.newPublic")}
                      </p>
                    )}
                  </div>
                  <div>
                    <h4 className="font-semibold text-sm mb-2">
                      {t("presets.proposed")}
                    </h4>
                    <PresetSummary
                      kind={r.kind}
                      payload={r.payload}
                      catalog={catalog}
                    />
                  </div>
                </div>
              </details>
              {canReview && r.status === "PENDING" && (
                <div className="space-y-2">
                  <label className="text-xs block">
                    {t("presets.reason")}
                    <textarea
                      className={inputCls}
                      maxLength={2000}
                      value={reasons[r.id] ?? ""}
                      onChange={(e) =>
                        setReasons({ ...reasons, [r.id]: e.target.value })
                      }
                    />
                  </label>
                  <div className="flex gap-4 text-sm">
                    <button
                      disabled={busy}
                      className="text-brand-deep font-semibold"
                      onClick={() =>
                        void run(() =>
                          reviewPreset(r.id, "APPROVED", reasons[r.id] ?? ""),
                        )
                      }
                    >
                      {t("presets.approve")}
                    </button>
                    <button
                      disabled={busy || !(reasons[r.id] ?? "").trim()}
                      className="text-danger disabled:opacity-50"
                      onClick={() =>
                        void run(() =>
                          reviewPreset(r.id, "REJECTED", reasons[r.id] ?? ""),
                        )
                      }
                    >
                      {t("presets.reject")}
                    </button>
                  </div>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
