"use client";

import { useState } from "react";
import Link from "next/link";
import { useT } from "@/lib/i18n/LanguageProvider";
import { ChemicalCategoryPicker } from "./ChemicalCategoryPicker";
import type { ChemicalCategory } from "@/modules/chemicals/types";
import type { ChemicalImportPreview } from "@/modules/chemicals/bulk-types";

const button =
  "min-h-11 px-3 py-2 border border-line rounded-[4px] text-sm font-semibold inline-flex items-center justify-center hover:bg-subtle disabled:opacity-50";
type ImportResult = {
  batchId: string;
  created: number;
  total: number;
  replayed: boolean;
};
export function ChemicalsBulkUpload({
  initialCategories,
}: {
  initialCategories: ChemicalCategory[];
}) {
  const t = useT();
  const [category, setCategory] = useState("SAM");
  const [categories, setCategories] = useState(initialCategories);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ChemicalImportPreview | null>(null);
  const [batchId, setBatchId] = useState("");
  const [busy, setBusy] = useState<"preview" | "import" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const submit = async (mode: "preview" | "import") => {
    if (!file || (mode === "import" && !preview?.valid)) return;
    setBusy(mode);
    setError(null);
    const form = new FormData();
    form.set("file", file);
    form.set("mode", mode);
    form.set("category", category);
    if (mode === "import" && preview) {
      form.set("batchId", batchId);
      form.set("expectedDigest", preview.fileSha256);
    }
    try {
      const response = await fetch("/api/chemicals/bulk", {
        method: "POST",
        body: form,
        credentials: "same-origin",
      });
      const body = await response.json();
      if (!body.ok) setError(body.error ?? "failed");
      else if (mode === "preview") {
        setPreview(body.preview);
        setResult(null);
      } else setResult(body.result);
    } catch {
      setError("failed");
    } finally {
      setBusy(null);
    }
  };
  const fileError = (code: string) => {
    const messages = {
      access: "chemicals.bulk.error.access",
      file: "chemicals.bulk.error.file",
      limits: "chemicals.bulk.error.limits",
      columns: "chemicals.bulk.error.columns",
      formulas: "chemicals.bulk.error.formulas",
      empty: "chemicals.bulk.error.empty",
      conflict: "chemicals.bulk.error.conflict",
      failed: "chemicals.bulk.error.failed",
    } as const;
    return t(messages[code as keyof typeof messages] ?? messages.failed);
  };
  return (
    <main
      className="h-full min-h-0 flex flex-col bg-subtle overflow-hidden"
      data-testid="chemicals-bulk"
    >
      <div className="px-4 sm:px-6 py-4 border-b border-line bg-surface shrink-0">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-bold">{t("chemicals.bulk.title")}</h1>
          <Link className={button} href="/chemicals">
            {t("chemicals.bulk.back")}
          </Link>
        </div>
        <p className="text-sm text-muted mt-2 max-w-3xl">
          {t("chemicals.bulk.intro")}
        </p>
      </div>
      <div className="flex-1 min-h-0 flex flex-col p-3 sm:p-4 gap-3">
        <section className="border border-line rounded-[6px] bg-surface p-4 shrink-0">
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-full sm:w-52 text-xs">
              <p className="mb-1">{t("chemicals.category")}</p>
              <ChemicalCategoryPicker
                value={category}
                categories={categories}
                label={t("chemicals.category")}
                disabled={!!busy}
                onChange={(value) => {
                  setCategory(value);
                  setPreview(null);
                  setResult(null);
                  setError(null);
                  setBatchId(crypto.randomUUID());
                }}
                onCreated={(value) =>
                  setCategories((old) => [
                    ...old.filter((c) => c.code !== value.code),
                    value,
                  ])
                }
              />
            </div>
            <a className={button} href="/api/chemicals/template">
              {t("chemicals.bulk.template")}
            </a>
            <label className="min-w-0 w-full sm:w-auto sm:flex-1 text-xs">
              {t("chemicals.bulk.file")}
              <input
                type="file"
                accept=".xlsx"
                className="block w-full min-h-11 border border-line rounded-[4px] p-2 mt-1 text-sm bg-surface"
                disabled={!!busy}
                onChange={(event) => {
                  setFile(event.target.files?.[0] ?? null);
                  setPreview(null);
                  setResult(null);
                  setError(null);
                  setBatchId(crypto.randomUUID());
                }}
              />
            </label>
            <button
              className={button}
              disabled={!file || !!busy || !!result}
              onClick={() => void submit("preview")}
            >
              {t(
                busy === "preview"
                  ? "chemicals.bulk.validating"
                  : "chemicals.bulk.validate",
              )}
            </button>
          </div>
          <p className="text-xs text-muted mt-2">
            {t("chemicals.bulk.limits")}
          </p>
          {error && (
            <p role="alert" className="text-sm text-red-700 mt-3">
              {fileError(error)}
            </p>
          )}
        </section>
        <section className="flex-1 min-h-0 flex flex-col border border-line rounded-[6px] bg-surface overflow-hidden">
          <div className="px-4 py-3 border-b border-line shrink-0 flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold text-sm">
              {t("chemicals.bulk.review")}
              {preview ? ` · ${preview.rows.length}` : ""}
            </h2>
            {preview && !result && (
              <button
                className={
                  button + " bg-charcoal text-white hover:bg-charcoal/90"
                }
                disabled={!preview.valid || !!busy}
                onClick={() => void submit("import")}
              >
                {t(
                  busy === "import"
                    ? "chemicals.bulk.importing"
                    : "chemicals.bulk.import",
                )}
              </button>
            )}
          </div>
          <div
            className="relative flex-1 min-h-0 overflow-auto"
            data-testid="bulk-review"
          >
            {!preview ? (
              <p className="p-4 text-sm text-muted">
                {t("chemicals.bulk.empty")}
              </p>
            ) : (
              <>
                {result && (
                  <div
                    role="status"
                    className="p-4 border-b border-line bg-brand-soft/30"
                  >
                    <p className="font-semibold text-sm">
                      {result.total}{" "}
                      {t(
                        result.replayed
                          ? "chemicals.bulk.replayed"
                          : "chemicals.bulk.success",
                      )}
                    </p>
                    <div className="flex flex-wrap gap-2 mt-3">
                      <Link className={button} href="/chemicals">
                        {t("chemicals.bulk.back")}
                      </Link>
                      <a
                        className={button}
                        href={`/api/chemicals/bulk/${result.batchId}/source`}
                      >
                        {t("chemicals.bulk.source")}
                      </a>
                    </div>
                  </div>
                )}
                {!preview.valid && !result && (
                  <p
                    role="alert"
                    className="p-4 text-sm text-red-700 border-b border-line"
                  >
                    {t("chemicals.bulk.fix")}
                  </p>
                )}
                <table className="w-full text-sm block sm:table">
                  <thead className="hidden sm:table-header-group sticky top-0 z-10 bg-subtle text-xs text-muted">
                    <tr>
                      <th className="p-3 text-left">
                        {t("chemicals.bulk.row")}
                      </th>
                      <th className="p-3 text-left">{t("chemicals.name")}</th>
                      <th className="p-3 text-left">SMILES</th>
                      <th className="p-3 text-left">
                        {t("chemicals.preview")}
                      </th>
                      <th className="p-3 text-left">{t("chemicals.status")}</th>
                    </tr>
                  </thead>
                  <tbody className="block sm:table-row-group">
                    {preview.rows.map((row) => (
                      <tr
                        key={row.row}
                        className="block sm:table-row border-b border-line p-3 sm:p-0"
                        data-testid="bulk-row"
                      >
                        <td className="block sm:table-cell sm:p-3 text-muted text-xs">
                          {t("chemicals.bulk.row")} {row.row}
                        </td>
                        <td className="block sm:table-cell py-2 sm:p-3 font-semibold break-words max-w-64">
                          {row.name || "—"}
                        </td>
                        <td className="block sm:table-cell py-2 sm:p-3 max-w-sm mono break-all text-xs">
                          {row.smiles || "—"}
                        </td>
                        <td className="block sm:table-cell py-2 sm:p-3">
                          {row.preview && (
                            <img
                              loading="lazy"
                              className="w-40 h-auto border border-line rounded-[4px] bg-white"
                              src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(row.preview.svg)}`}
                              alt={`${row.name} · ${t("chemicals.preview")}`}
                            />
                          )}
                        </td>
                        <td className="block sm:table-cell py-2 sm:p-3 text-xs max-w-xs">
                          {row.issues.length ? (
                            <ul className="space-y-1 text-red-700">
                              {row.issues.map((issue) => (
                                <li key={issue}>
                                  {t(`chemicals.bulk.issue.${issue}`)}
                                </li>
                              ))}
                            </ul>
                          ) : (
                            t(
                              result
                                ? "chemicals.saved"
                                : row.linksExisting
                                  ? "chemicals.bulk.linkExisting"
                                  : "chemicals.bulk.ready",
                            )
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
