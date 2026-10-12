"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/ui";
import { useT } from "@/lib/i18n/LanguageProvider";
import {
  previewChemicalAction,
  saveChemicalAction,
} from "@/lib/actions/chemicals";
import type { ChemicalRow, MoleculePreview } from "@/modules/chemicals/types";

type Draft = {
  key: string;
  id: string | null;
  name: string;
  category: string;
  smiles: string;
  expectedVersion: number;
  expectedDigest: string | null;
  requestId: string;
  dirty: boolean;
  saving: boolean;
  error: string | null;
  saved: boolean;
  chemistry: ChemicalRow["chemistry"];
};
const draftFrom = (row: ChemicalRow): Draft => ({
  key: row.id,
  id: row.id,
  name: row.name,
  category: row.category,
  smiles: row.smiles,
  expectedVersion: row.chemistry?.version ?? 0,
  expectedDigest: row.rowDigest,
  requestId: "",
  dirty: false,
  saving: false,
  error: null,
  saved: false,
  chemistry: row.chemistry,
});
const control =
  "w-full min-h-11 border border-line rounded-[4px] px-3 py-2 text-sm bg-surface focus:outline-2 focus:outline-brand-deep focus:outline-offset-2 disabled:opacity-60";
const button =
  "min-h-11 px-3 py-2 border border-line rounded-[4px] text-sm font-semibold hover:bg-subtle disabled:opacity-50 inline-flex items-center justify-center gap-2";

export function ChemicalsWorkbench({
  data,
  query,
}: {
  data: {
    rows: ChemicalRow[];
    total: number;
    page: number;
  };
  query: string;
}) {
  const t = useT();
  const [rows, setRows] = useState<Draft[]>(() => data.rows.map(draftFrom));
  const [selected, setSelected] = useState<string | null>(
    data.rows[0]?.id ?? null,
  );
  const [previewValue, setPreview] = useState<MoleculePreview | null>(null),
    [loading, setPreviewing] = useState(false),
    [rawPreviewError, setPreviewError] = useState<string | null>(null),
    [previewSource, setPreviewSource] = useState("");
  const [showInspector, setShowInspector] = useState(true),
    [focus, setFocus] = useState(false),
    [width, setWidth] = useState(360);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      try {
        const stored = JSON.parse(
          localStorage.getItem("pheno-chemical-view") ?? "null",
        );
        if (stored) {
          setWidth(Math.max(280, Math.min(480, Number(stored.width) || 360)));
          setShowInspector(stored.visible !== false);
        }
      } catch {}
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  const persistView = (nextWidth: number, visible: boolean) => {
    setWidth(nextWidth);
    setShowInspector(visible);
    try {
      localStorage.setItem(
        "pheno-chemical-view",
        JSON.stringify({ width: nextWidth, visible }),
      );
    } catch {}
  };
  const row = rows.find((r) => r.key === selected);
  const preview = previewSource === row?.smiles ? previewValue : null;
  const previewImage = preview
    ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(preview.svg)}`
    : null;
  const previewError = previewSource === row?.smiles ? rawPreviewError : null;
  const previewing =
    !!row?.smiles.trim() && (loading || previewSource !== row.smiles);
  useEffect(() => {
    let cancelled = false;
    if (!row?.smiles.trim()) return;
    const timer = setTimeout(() => {
      setPreviewSource(row.smiles);
      setPreview(null);
      setPreviewError(null);
      setPreviewing(true);
      void previewChemicalAction(row.smiles)
        .then((result) => {
          if (cancelled) return;
          if (result.ok) setPreview(result.value);
          else setPreviewError(result.error);
        })
        .catch(() => {
          if (!cancelled) setPreviewError("failed");
        })
        .finally(() => {
          if (!cancelled) setPreviewing(false);
        });
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [selected, row?.smiles]);
  useEffect(() => {
    if (!rows.some((r) => r.dirty)) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [rows]);
  const errorText = (error: string) =>
    t(
      error === "invalidSmiles"
        ? "chemicals.error.invalidSmiles"
        : error === "conflict"
          ? "chemicals.error.conflict"
          : "chemicals.error.failed",
    );
  const patch = (key: string, value: Partial<Draft>) => {
    setSelected(key);
    setRows((old) =>
      old.map((r) =>
        r.key === key
          ? {
              ...r,
              ...value,
              requestId: crypto.randomUUID(),
              dirty: true,
              saved: false,
              error: null,
            }
          : r,
      ),
    );
  };
  const addRow = () => {
    const key = crypto.randomUUID();
    setRows((old) => [
      {
        key,
        id: null,
        name: "",
        category: "SAM",
        smiles: "",
        expectedVersion: 0,
        expectedDigest: null,
        requestId: crypto.randomUUID(),
        dirty: true,
        saving: false,
        error: null,
        saved: false,
        chemistry: null,
      },
      ...old,
    ]);
    setSelected(key);
    setFocus(false);
  };
  const save = async (draft: Draft) => {
    const requestId = draft.requestId || crypto.randomUUID();
    setRows((old) =>
      old.map((r) =>
        r.key === draft.key
          ? { ...r, saving: true, error: null, requestId }
          : r,
      ),
    );
    try {
      const result = await saveChemicalAction({
        id: draft.id,
        requestId,
        expectedVersion: draft.expectedVersion,
        expectedDigest: draft.expectedDigest,
        name: draft.name,
        category: draft.category,
        smiles: draft.smiles,
      });
      setRows((old) =>
        old.map((r) =>
          r.key !== draft.key
            ? r
            : result.ok
              ? {
                  ...draftFrom(result.row),
                  key: draft.key,
                  requestId,
                  saved: true,
                }
              : { ...r, saving: false, error: result.error },
        ),
      );
    } catch {
      setRows((old) =>
        old.map((r) =>
          r.key === draft.key ? { ...r, saving: false, error: "failed" } : r,
        ),
      );
    }
  };
  const pageLink = (page: number) =>
    `/chemicals?page=${page}&q=${encodeURIComponent(query)}`;
  return (
    <main
      className="h-full min-h-0 flex flex-col bg-subtle overflow-hidden"
      data-testid="chemicals-workbench"
    >
      <div className="px-4 sm:px-6 py-4 border-b border-line bg-surface shrink-0">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Icon name="Atom" size={22} />
            {t("chemicals.title")}
          </h1>
          <button
            className={button + " bg-charcoal text-white hover:bg-charcoal/90"}
            onClick={addRow}
          >
            <Icon name="Plus" size={16} />
            {t("chemicals.addRow")}
          </button>
        </div>
        <p className="text-sm text-muted mt-2 max-w-3xl">
          {t("chemicals.intro")}
        </p>
        <div className="flex flex-wrap items-center gap-2 mt-3">
          <Link className={button} href="/chemicals/bulk">
            {t("chemicals.bulk.link")}
          </Link>
          <form
            action="/chemicals"
            className="flex gap-2 w-full sm:w-auto sm:flex-1 min-w-0 sm:min-w-60 max-w-md"
          >
            <input
              className={control}
              name="q"
              defaultValue={query}
              aria-label={t("chemicals.search")}
              placeholder={t("chemicals.search")}
            />
            <button
              className={button}
              type="submit"
              aria-label={t("chemicals.search")}
            >
              <Icon name="Search" size={17} />
            </button>
          </form>
          <button
            className={button}
            onClick={() => {
              if (window.innerWidth < 1280) {
                setShowInspector(true);
                setFocus(!focus);
              } else {
                persistView(width, !showInspector);
                setFocus(false);
              }
            }}
          >
            <span className="hidden xl:inline">
              {t(
                showInspector ? "chemicals.hideInspector" : "chemicals.inspect",
              )}
            </span>
            <span className="xl:hidden">
              {t(focus ? "chemicals.restore" : "chemicals.inspect")}
            </span>
          </button>
          <button
            className={button}
            onClick={() => {
              persistView(360, true);
              setFocus(false);
            }}
          >
            {t("chemicals.reset")}
          </button>
          <a className={button} href="/api/chemicals/analysis">
            {t("chemicals.export")}
          </a>
        </div>
      </div>
      <div className="flex-1 min-h-0 flex gap-0 p-3 sm:p-4">
        <section
          aria-label={t("chemicals.name")}
          className={
            (focus ? "hidden " : "") +
            "flex-1 min-w-0 flex flex-col border border-line bg-surface rounded-[6px] overflow-hidden"
          }
        >
          <div
            className="relative flex-1 min-h-0 overflow-auto"
            data-testid="registry-body"
          >
            <table className="w-full text-sm block sm:table">
              <thead className="hidden sm:table-header-group sticky top-0 bg-subtle z-10 text-xs text-muted">
                <tr>
                  <th className="p-3 text-left">{t("chemicals.name")}</th>
                  <th className="p-3 text-left">{t("chemicals.category")}</th>
                  <th className="p-3 text-left">SMILES</th>
                  <th className="p-3 text-left">{t("chemicals.status")}</th>
                  <th className="p-3" />
                </tr>
              </thead>
              <tbody className="block sm:table-row-group">
                {rows.map((draft, index) => (
                  <tr
                    key={draft.key}
                    className={
                      "block sm:table-row border-b border-line " +
                      (selected === draft.key ? "bg-brand-soft/30" : "")
                    }
                    data-testid="chemical-row"
                  >
                    <td className="block sm:table-cell p-3 sm:min-w-48">
                      <label
                        className="block text-xs sm:sr-only mb-1"
                        htmlFor={`name-${draft.key}`}
                      >
                        {t("chemicals.name")}
                      </label>
                      <div className="flex gap-2">
                        <button
                          className={button + " shrink-0 w-11 px-0"}
                          title={t("chemicals.select")}
                          aria-label={`${t("chemicals.select")} ${index + 1}`}
                          aria-pressed={selected === draft.key}
                          onClick={() => setSelected(draft.key)}
                        >
                          <Icon name="Atom" size={17} />
                        </button>
                        <input
                          id={`name-${draft.key}`}
                          aria-label={`${t("chemicals.name")} ${index + 1}`}
                          className={control + " min-w-0"}
                          value={draft.name}
                          maxLength={200}
                          disabled={draft.saving}
                          onFocus={() => setSelected(draft.key)}
                          onChange={(e) =>
                            patch(draft.key, { name: e.target.value })
                          }
                        />
                      </div>
                    </td>
                    <td className="block sm:table-cell px-3 pb-3 sm:py-3 sm:min-w-36">
                      <label
                        className="block text-xs sm:sr-only mb-1"
                        htmlFor={`category-${draft.key}`}
                      >
                        {t("chemicals.category")}
                      </label>
                      <input
                        id={`category-${draft.key}`}
                        aria-label={`${t("chemicals.category")} ${index + 1}`}
                        className={control + " bg-subtle"}
                        value="SAM"
                        readOnly
                      />
                    </td>
                    <td className="block sm:table-cell px-3 pb-3 sm:py-3 sm:min-w-64">
                      <label
                        className="block text-xs sm:sr-only mb-1"
                        htmlFor={`smiles-${draft.key}`}
                      >
                        SMILES
                      </label>
                      <textarea
                        id={`smiles-${draft.key}`}
                        aria-label={`SMILES ${index + 1}`}
                        className={control + " mono resize-y min-h-14"}
                        value={draft.smiles}
                        maxLength={4000}
                        rows={2}
                        spellCheck={false}
                        disabled={draft.saving}
                        onFocus={() => setSelected(draft.key)}
                        onChange={(e) =>
                          patch(draft.key, { smiles: e.target.value })
                        }
                      />
                    </td>
                    <td className="block sm:table-cell px-3 pb-3 sm:py-3 sm:min-w-36">
                      {((selected === draft.key && previewImage) ||
                        (draft.id && draft.chemistry && !draft.dirty)) && (
                        <img
                          className="w-40 h-auto border border-line bg-white rounded-[4px] mb-2"
                          src={
                            (selected === draft.key && previewImage) ||
                            `/api/chemicals/${draft.id}/structure`
                          }
                          alt={`${draft.name} · ${t("chemicals.preview")}`}
                          data-testid="row-molecule"
                        />
                      )}
                      <span className="text-xs flex items-center gap-1">
                        <Icon
                          name={
                            draft.chemistry && !draft.dirty
                              ? "CircleCheck"
                              : "CircleDot"
                          }
                          size={14}
                        />
                        {t(
                          draft.saved
                            ? "chemicals.saved"
                            : draft.dirty
                              ? "chemicals.draft"
                              : draft.chemistry
                                ? "chemicals.validated"
                                : draft.smiles
                                  ? "chemicals.legacy"
                                  : "chemicals.missing",
                        )}
                      </span>
                    </td>
                    <td className="block sm:table-cell px-3 pb-3 sm:py-3 sm:min-w-28">
                      <div className="flex gap-2">
                        <button
                          className={
                            button +
                            " bg-charcoal text-white hover:bg-charcoal/90"
                          }
                          disabled={
                            draft.saving ||
                            !draft.name.trim() ||
                            !draft.smiles.trim() ||
                            (!draft.dirty && !!draft.chemistry)
                          }
                          onClick={() => void save(draft)}
                        >
                          {t(
                            draft.saving
                              ? "chemicals.saving"
                              : "chemicals.save",
                          )}
                        </button>
                        {!draft.id && (
                          <button
                            className={button + " w-11 px-0"}
                            aria-label={t("chemicals.removeDraft")}
                            onClick={() => {
                              setRows((old) =>
                                old.filter((r) => r.key !== draft.key),
                              );
                              if (selected === draft.key) setSelected(null);
                            }}
                          >
                            <Icon name="X" size={15} />
                          </button>
                        )}
                      </div>
                      {draft.error && (
                        <p
                          className="mt-2 text-xs text-red-700 max-w-64"
                          role="alert"
                        >
                          {errorText(draft.error)}
                        </p>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!rows.length && (
              <p className="p-6 text-sm text-muted">{t("chemicals.empty")}</p>
            )}
          </div>
          <div className="shrink-0 border-t border-line px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-xs">
            <span>
              {t("chemicals.page")} {data.page} · {data.total}
            </span>
            <div className="flex gap-2">
              {data.page > 1 && (
                <Link className={button} href={pageLink(data.page - 1)}>
                  {t("chemicals.previous")}
                </Link>
              )}
              {data.page * 40 < data.total && (
                <Link className={button} href={pageLink(data.page + 1)}>
                  {t("chemicals.next")}
                </Link>
              )}
            </div>
          </div>
        </section>
        {showInspector && (
          <aside
            style={!focus ? { width } : undefined}
            className={
              (focus ? "flex-1 " : "hidden xl:flex ml-4 shrink-0 ") +
              "min-w-0 flex flex-col border border-line bg-surface rounded-[6px] overflow-hidden"
            }
            aria-label={t("chemicals.preview")}
            data-testid="molecule-inspector"
          >
            <div className="p-3 border-b border-line shrink-0 flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-semibold text-sm">
                {t("chemicals.preview")}
              </h2>
              <button className={button} onClick={() => setFocus(!focus)}>
                {t(focus ? "chemicals.restore" : "chemicals.focus")}
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-auto p-4">
              <h3 className="text-base font-semibold break-words mb-3">
                {row?.name || t("chemicals.previewHint")}
              </h3>
              {previewing ? (
                <p role="status" className="text-sm text-muted">
                  {t("chemicals.previewing")}
                </p>
              ) : previewError ? (
                <p role="alert" className="text-sm text-red-700">
                  {errorText(previewError)}
                </p>
              ) : preview ? (
                <>
                  <img
                    className="w-full border border-line bg-white rounded-[4px]"
                    src={previewImage!}
                    alt={`${row?.name ?? ""} · ${t("chemicals.preview")}`}
                  />
                  <dl className="text-xs mt-4 space-y-3">
                    <div>
                      <dt className="text-muted">{t("chemicals.atoms")}</dt>
                      <dd>{preview.atomCount}</dd>
                    </div>
                    <div>
                      <dt className="text-muted">{t("chemicals.canonical")}</dt>
                      <dd className="mono break-all mt-1">
                        {preview.canonicalSmiles}
                      </dd>
                    </div>
                    <div>
                      <dt>RDKit</dt>
                      <dd>{preview.engineVersion}</dd>
                    </div>
                  </dl>
                </>
              ) : (
                <p className="text-sm text-muted">
                  {t("chemicals.previewHint")}
                </p>
              )}
              <p className="text-xs text-muted mt-4">
                {t("chemicals.generated")}
              </p>
              {!focus && (
                <label className="hidden xl:block text-xs text-muted mt-5">
                  {t("chemicals.width")}
                  <input
                    type="range"
                    min={280}
                    max={480}
                    step={20}
                    value={width}
                    className="w-full mt-2 min-h-11 accent-brand-deep"
                    onChange={(e) => persistView(Number(e.target.value), true)}
                  />
                </label>
              )}
            </div>
          </aside>
        )}
      </div>
    </main>
  );
}
