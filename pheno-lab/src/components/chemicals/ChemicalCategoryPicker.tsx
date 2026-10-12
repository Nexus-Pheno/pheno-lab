"use client";
import { useState } from "react";
import { useT, useLang } from "@/lib/i18n/LanguageProvider";
import { createChemicalCategoryAction } from "@/lib/actions/chemicals";
import type { ChemicalCategory } from "@/modules/chemicals/types";

const control =
  "w-full min-h-11 border border-line rounded-[4px] px-3 py-2 text-sm bg-surface disabled:opacity-60";
export function ChemicalCategoryPicker({
  value,
  categories,
  label,
  disabled,
  onChange,
  onCreated,
}: {
  value: string;
  categories: ChemicalCategory[];
  label: string;
  disabled?: boolean;
  onChange: (code: string) => void;
  onCreated: (category: ChemicalCategory) => void;
}) {
  const t = useT(),
    lang = useLang();
  const [adding, setAdding] = useState(false),
    [name, setName] = useState(""),
    [nameZh, setNameZh] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(false);
  const defaults: ChemicalCategory[] = [
    { code: "SAM", name: t("chemicals.sam"), nameZh: t("chemicals.sam") },
    {
      code: "ADDITIVE",
      name: t("chemicals.additive"),
      nameZh: t("chemicals.additive"),
    },
    {
      code: "SOLVENT",
      name: t("chemicals.solvent"),
      nameZh: t("chemicals.solvent"),
    },
  ];
  const options = [
    ...defaults,
    ...categories.filter((c) => !defaults.some((d) => d.code === c.code)),
  ];
  if (!options.some((c) => c.code === value))
    options.push({ code: value, name: value, nameZh: value });
  const create = async () => {
    setBusy(true);
    setError(false);
    try {
      const result = await createChemicalCategoryAction({ name, nameZh });
      if (result.ok) {
        onCreated(result.value);
        onChange(result.value.code);
        setAdding(false);
        setName("");
        setNameZh("");
      } else setError(true);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      <select
        className={control}
        aria-label={label}
        value={value}
        disabled={disabled || busy}
        onChange={(e) =>
          e.target.value === "__add__"
            ? setAdding(true)
            : onChange(e.target.value)
        }
      >
        {options.map((c) => (
          <option key={c.code} value={c.code}>
            {lang === "zh" ? c.nameZh || c.name : c.name}
          </option>
        ))}
        <option value="__add__">{t("chemicals.addCategory")}</option>
      </select>
      {adding && (
        <div className="space-y-2" data-testid="chemical-category-create">
          <input
            className={control}
            aria-label={t("chemicals.categoryName")}
            placeholder={t("chemicals.categoryName")}
            maxLength={100}
            value={name}
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            className={control}
            aria-label={t("chemicals.categoryNameZh")}
            placeholder={t("chemicals.categoryNameZh")}
            maxLength={100}
            value={nameZh}
            disabled={busy}
            onChange={(e) => setNameZh(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <button
              className={control + " sm:w-auto"}
              disabled={busy || !name.trim()}
              onClick={() => void create()}
            >
              {t("chemicals.createCategory")}
            </button>
            <button
              className={control + " sm:w-auto"}
              disabled={busy}
              onClick={() => setAdding(false)}
            >
              {t("chemicals.cancel")}
            </button>
          </div>
          {error && (
            <p role="alert" className="text-xs text-red-700">
              {t("chemicals.error.failed")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
