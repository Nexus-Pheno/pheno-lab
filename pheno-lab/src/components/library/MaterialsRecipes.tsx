"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { Material } from "@prisma/client";
import {
  saveMaterialCard, setMaterialArchived, saveRecipe, setRecipeArchived,
  createMaterialCategory, renameMaterialCategory, deleteMaterialCategory, moveMaterialCategory,
} from "@/lib/actions/materials";
import type { MaterialCard, RecipePayload } from "@/lib/materials-meta";
import { fuzzyFilter } from "@/lib/fuzzy";
import { useT, useTerm } from "@/lib/i18n/LanguageProvider";
import { Icon, FieldLabel, inputCls } from "@/components/ui";
import { MoleculeView } from "./MoleculeView";
import { useLang } from "@/lib/i18n/LanguageProvider";

export type CategoryRow = { id: string; code: string; name: string; nameZh: string; builtIn: boolean };

// ---------------- Materials library ----------------
//
// Org-wide wiki of the lab's actual materials, grouped by category. Cards
// carry identity (formula, CAS, MW), sourcing (vendor, batch, purity) and
// characteristics (HOMO/LUMO, bp, …). Only material administrators edit.

export function MaterialsSection({
  materials,
  categories,
  canManage,
}: {
  materials: Material[];
  categories: CategoryRow[];
  canManage: boolean;
}) {
  const t = useT();
  const tt = useTerm();
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [openCat, setOpenCat] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Material | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [managingCats, setManagingCats] = useState(false);
  const lang = useLang();
  const catLabel = (c: CategoryRow) => (lang === "zh" && c.nameZh ? c.nameZh : c.name);

  const visible = useMemo(() => {
    const pool = materials.filter((m) => (showArchived ? true : !m.archived));
    return fuzzyFilter(pool, query, (m) => `${m.name} ${m.composition} ${m.casNumber}`);
  }, [materials, query, showArchived]);

  const total = materials.filter((m) => !m.archived).length;
  const searching = query.trim().length > 0;

  return (
    <section>
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2.5 text-left"
      >
        <h2 className="text-[15px] font-bold flex items-center gap-2">
          <Icon name="FlaskConical" size={16} className="text-brand-deep" /> {t("mat.title")}
        </h2>
        <span className="mono text-[11px] text-muted">{total}</span>
        <span className="text-[11px] text-muted hidden sm:inline flex-1 truncate">{t("mat.subtitle")}</span>
        <span className="flex-1 sm:hidden" />
        <Icon name={expanded ? "ChevronUp" : "ChevronDown"} size={15} className="text-muted shrink-0" />
      </button>

      {expanded && (
      <>
      <div className="flex flex-wrap items-center gap-2 mt-2 mb-1">
        <input
          className="h-8 border border-line rounded-[4px] px-3 text-[12.5px] bg-surface flex-1 min-w-48"
          placeholder={t("mat.search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          onClick={() => setShowArchived((v) => !v)}
          className={"h-8 px-2.5 text-[11px] font-semibold border rounded-[4px] shrink-0 " +
            (showArchived ? "bg-ink text-white border-ink" : "border-line text-muted hover:bg-subtle")}
        >
          {t("lib.archived")}
        </button>
        {canManage && (
          <button
            onClick={() => setManagingCats(true)}
            className="h-8 px-2.5 text-[11px] font-semibold border border-line text-charcoal rounded-[4px] shrink-0 hover:bg-subtle flex items-center gap-1"
          >
            <Icon name="Settings2" size={12} /> {t("mat.categories")}
          </button>
        )}
      </div>
      {!canManage && <p className="text-[10.5px] text-muted mb-2">{t("mat.readonlyHint")}</p>}

      <div className="bg-surface border border-line rounded-[6px] divide-y divide-line mt-2">
        {categories.map((cat) => {
          const items = visible.filter((m) => m.category === cat.code);
          if (items.length === 0 && !canManage) return null;
          const catOpen = searching ? items.length > 0 : openCat === cat.code;
          return (
            <div key={cat.id}>
              <div className="flex items-center gap-2 px-3.5 py-2.5">
                <button
                  onClick={() => setOpenCat(catOpen && !searching ? null : cat.code)}
                  className="flex items-center gap-2 flex-1 text-left hover:opacity-70"
                >
                  <Icon name={catOpen ? "ChevronUp" : "ChevronDown"} size={13} className="text-muted shrink-0" />
                  <h3 className="text-[12.5px] font-semibold">{catLabel(cat)}</h3>
                  <span className="mono text-[11px] text-muted">{items.length}</span>
                </button>
                {canManage && (
                  <button
                    onClick={() => setCreating(cat.code)}
                    className="text-[11px] font-semibold text-brand-deep flex items-center gap-0.5 shrink-0"
                  >
                    <Icon name="Plus" size={11} /> {t("mat.add")}
                  </button>
                )}
              </div>
              {catOpen && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 px-3.5 pb-3 bg-subtle/40 pt-2 border-t border-line">
                {items.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => setOpen(m)}
                    className={
                      "text-left bg-surface border border-line rounded-[6px] p-2.5 hover:border-charcoal/40 " +
                      (m.archived ? "opacity-45" : "")
                    }
                  >
                    <div className="text-[12.5px] font-bold truncate">{tt(m.name)}</div>
                    <div className="mono text-[10.5px] text-muted truncate">
                      {m.composition.split("—")[0].trim() || "—"}
                    </div>
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {m.molecularWeight && m.molecularWeight !== "—" && (
                        <span className="text-[9.5px] px-1 py-0.5 bg-subtle border border-line rounded-[3px] mono">{m.molecularWeight} g/mol</span>
                      )}
                      {m.supplier && (
                        <span className="text-[9.5px] px-1 py-0.5 bg-subtle border border-line rounded-[3px]">{m.supplier}</span>
                      )}
                      {m.lot && (
                        <span className="text-[9.5px] px-1 py-0.5 bg-subtle border border-line rounded-[3px] mono">{t("mat.lot")} {m.lot}</span>
                      )}
                    </div>
                  </button>
                ))}
                {items.length === 0 && (
                  <p className="text-[11px] text-muted py-1">{t("mat.emptyCat")}</p>
                )}
              </div>
              )}
            </div>
          );
        })}
        {visible.length === 0 && query && (
          <p className="text-[12px] text-muted px-3.5 py-3">{t("mat.noMatch")}</p>
        )}
      </div>
      </>
      )}

      {managingCats && (
        <CategoryManager
          categories={categories}
          onClose={() => setManagingCats(false)}
          onChanged={() => router.refresh()}
        />
      )}

      {(open || creating) && (
        <MaterialModal
          material={open}
          categories={categories}
          category={creating ?? open?.category ?? categories[0]?.code ?? "OTHER"}
          canManage={canManage}
          onClose={() => { setOpen(null); setCreating(null); }}
          onSaved={() => { setOpen(null); setCreating(null); router.refresh(); }}
        />
      )}
    </section>
  );
}

function MaterialModal({
  material, categories, category, canManage, onClose, onSaved,
}: {
  material: Material | null;
  categories: CategoryRow[];
  category: string;
  canManage: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const [form, setForm] = useState<MaterialCard>({
    name: material?.name ?? "",
    category: material?.category ?? category,
    composition: material?.composition ?? "",
    smiles: material?.smiles ?? "",
    casNumber: material?.casNumber ?? "",
    molecularWeight: material?.molecularWeight ?? "",
    purity: material?.purity ?? "",
    supplier: material?.supplier ?? "",
    lot: material?.lot ?? "",
    properties: (material?.properties as Record<string, string> | null) ?? {},
    notes: material?.notes ?? "",
    processId: material?.processId ?? null,
  });
  const [props, setProps] = useState<[string, string][]>(Object.entries(form.properties));
  const [busy, setBusy] = useState(false);
  const patch = (p: Partial<MaterialCard>) => setForm((f) => ({ ...f, ...p }));
  const ro = !canManage;

  const field = (label: string, key: keyof MaterialCard, mono = false) => (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <input
        className={inputCls + (mono ? " mono" : "")}
        value={form[key] as string}
        readOnly={ro}
        onChange={(e) => patch({ [key]: e.target.value } as Partial<MaterialCard>)}
      />
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 bg-ink/30 flex items-end sm:items-center justify-center p-0 sm:p-6" onClick={onClose}>
      <div
        className="w-full sm:max-w-lg bg-surface rounded-t-[10px] sm:rounded-[10px] border border-line max-h-[88dvh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-line">
          <span className="text-[13px] font-bold truncate">{material ? material.name : t("mat.new")}</span>
          <button onClick={onClose} className="p-1.5 -m-1 text-muted hover:bg-subtle rounded-[4px]"><Icon name="X" size={16} /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {field(t("mat.name"), "name")}
            <div>
              <FieldLabel>{t("mat.category")}</FieldLabel>
              <select
                className="h-9 w-full border border-line rounded-[4px] px-2 text-[12.5px] bg-surface disabled:bg-subtle"
                value={form.category}
                disabled={ro}
                onChange={(e) => patch({ category: e.target.value })}
              >
                {categories.map((c) => (
                  <option key={c.id} value={c.code}>{lang === "zh" && c.nameZh ? c.nameZh : c.name}</option>
                ))}
              </select>
            </div>
          </div>
          {field(t("mat.formula"), "composition", true)}
          {(form.smiles || !ro) && (
            <div>
              <FieldLabel>{t("mat.smiles")}</FieldLabel>
              <input
                className={inputCls + " mono"}
                placeholder="e.g. OP(=O)(O)CCn1c2ccccc2c2ccccc21"
                value={form.smiles}
                readOnly={ro}
                onChange={(e) => patch({ smiles: e.target.value })}
              />
              <p className="text-[10px] text-muted mt-1">{t("mat.smilesHint")}</p>
            </div>
          )}
          {form.smiles.trim() && (
            <div>
              <FieldLabel>{t("mat.structure")}</FieldLabel>
              <MoleculeView smiles={form.smiles} />
            </div>
          )}
          <div className="grid grid-cols-3 gap-2.5">
            {field("CAS", "casNumber", true)}
            {field(t("mat.mw"), "molecularWeight", true)}
            {field(t("mat.purity"), "purity", true)}
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            {field(t("mat.vendor"), "supplier")}
            {field(t("mat.lot"), "lot", true)}
          </div>
          <div>
            <FieldLabel>{t("mat.props")}</FieldLabel>
            <div className="space-y-1.5">
              {props.map(([k, v], i) => (
                <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-1.5">
                  <input className={inputCls} value={k} readOnly={ro} placeholder={t("mat.propName")}
                    onChange={(e) => setProps((p) => p.map((x, j) => (j === i ? [e.target.value, x[1]] : x)))} />
                  <input className={inputCls + " mono"} value={v} readOnly={ro} placeholder={t("cap.value")}
                    onChange={(e) => setProps((p) => p.map((x, j) => (j === i ? [x[0], e.target.value] : x)))} />
                  {!ro && (
                    <button onClick={() => setProps((p) => p.filter((_, j) => j !== i))} className="p-1.5 text-muted hover:text-danger">
                      <Icon name="X" size={13} />
                    </button>
                  )}
                </div>
              ))}
              {!ro && (
                <button onClick={() => setProps((p) => [...p, ["", ""]])} className="text-[11px] font-semibold text-brand-deep flex items-center gap-1">
                  <Icon name="Plus" size={11} /> {t("mat.addProp")}
                </button>
              )}
            </div>
          </div>
          <div>
            <FieldLabel>{t("mat.notes")}</FieldLabel>
            <textarea className={inputCls + " resize-none"} rows={2} value={form.notes} readOnly={ro}
              onChange={(e) => patch({ notes: e.target.value })} />
          </div>
        </div>
        {canManage && (
          <div className="flex items-center gap-2 px-4 py-3 border-t border-line">
            {material && (
              <button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  await setMaterialArchived(material.id, !material.archived);
                  setBusy(false);
                  onSaved();
                }}
                className="text-[11.5px] font-semibold text-muted hover:text-danger"
              >
                {t(material.archived ? "lib.unarchive" : "lib.archive")}
              </button>
            )}
            <span className="flex-1" />
            <button onClick={onClose} className="h-9 px-4 border border-line rounded-[4px] text-[12.5px] font-semibold text-charcoal">
              {t("insp.cancel")}
            </button>
            <button
              disabled={busy || !form.name.trim()}
              onClick={async () => {
                setBusy(true);
                await saveMaterialCard(material?.id ?? null, {
                  ...form,
                  properties: Object.fromEntries(props.filter(([k]) => k.trim())),
                });
                setBusy(false);
                onSaved();
              }}
              className="h-9 px-4 bg-brand text-[#243000] rounded-[4px] text-[12.5px] font-bold disabled:opacity-50"
            >
              {t("insp.save")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------- Recipes ----------------
//
// Proprietary perovskite recipes. Everyone sees names/summaries and can use
// them in planning; contents are visible & editable only with recipeAccess.

export type RecipeRow = {
  id: string;
  name: string;
  summary: string;
  archived: boolean;
  payload: RecipePayload | null; // null when the viewer lacks access
};

export function RecipesSection({ recipes, canView }: { recipes: RecipeRow[]; canView: boolean }) {
  const t = useT();
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [open, setOpen] = useState<RecipeRow | null>(null);
  const [creating, setCreating] = useState(false);
  const live = recipes.filter((r) => !r.archived);

  return (
    <section>
      <button onClick={() => setExpanded((v) => !v)} className="w-full flex items-center gap-2.5 text-left">
        <h2 className="text-[15px] font-bold flex items-center gap-2">
          <Icon name="BookLock" size={16} className="text-brand-deep" /> {t("rec.title")}
        </h2>
        <span className="mono text-[11px] text-muted">{live.length}</span>
        <span className="text-[11px] text-muted hidden sm:inline flex-1 truncate">{t("rec.subtitle")}</span>
        <span className="flex-1 sm:hidden" />
        <Icon name={expanded ? "ChevronUp" : "ChevronDown"} size={15} className="text-muted shrink-0" />
      </button>

      {expanded && (
      <>
      {canView && (
        <div className="flex justify-end mt-2">
          <button
            onClick={() => setCreating(true)}
            className="h-8 px-3 text-[11.5px] font-bold text-brand-deep border border-brand/40 bg-brand-soft rounded-[4px] flex items-center gap-1"
          >
            <Icon name="Plus" size={12} /> {t("rec.add")}
          </button>
        </div>
      )}
      {!canView && <p className="text-[10.5px] text-muted mt-2 mb-2">{t("rec.lockedHint")}</p>}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
        {recipes.filter((r) => !r.archived).map((r) => (
          <button
            key={r.id}
            onClick={() => canView && setOpen(r)}
            className={
              "text-left bg-surface border border-line rounded-[6px] p-3 " +
              (canView ? "hover:border-charcoal/40" : "cursor-default")
            }
          >
            <div className="flex items-center gap-1.5">
              <span className="text-[12.5px] font-bold flex-1 truncate">{r.name}</span>
              {!canView && <Icon name="Lock" size={12} className="text-muted shrink-0" />}
            </div>
            <div className="text-[11px] text-muted mt-0.5">{r.summary || "—"}</div>
            {!canView && (
              <div className="text-[10px] text-warn mt-1.5">{t("rec.hidden")}</div>
            )}
          </button>
        ))}
        {live.length === 0 && (
          <p className="text-[12px] text-muted">{t("rec.empty")}</p>
        )}
      </div>
      </>
      )}

      {canView && (open || creating) && (
        <RecipeModal
          recipe={open}
          onClose={() => { setOpen(null); setCreating(false); }}
          onSaved={() => { setOpen(null); setCreating(false); router.refresh(); }}
        />
      )}
    </section>
  );
}

function RecipeModal({
  recipe, onClose, onSaved,
}: {
  recipe: RecipeRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(recipe?.name ?? "");
  const [summary, setSummary] = useState(recipe?.summary ?? "");
  const [components, setComponents] = useState<{ material: string; amount: string }[]>(
    recipe?.payload?.components?.length ? recipe.payload.components : [{ material: "", amount: "" }]
  );
  const [solvents, setSolvents] = useState(recipe?.payload?.solvents ?? "");
  const [concentration, setConcentration] = useState(recipe?.payload?.concentration ?? "");
  const [procedure, setProcedure] = useState(recipe?.payload?.procedure ?? "");
  // Formula-sheet fields (set by ingestion) — edited here so a saved recipe
  // never silently loses what was ingested.
  const [composition, setComposition] = useState(recipe?.payload?.composition ?? "");
  const [bandGap, setBandGap] = useState(recipe?.payload?.bandGap ?? "");
  const [busy, setBusy] = useState(false);

  return (
    <div className="fixed inset-0 z-50 bg-ink/30 flex items-end sm:items-center justify-center p-0 sm:p-6" onClick={onClose}>
      <div
        className="w-full sm:max-w-lg bg-surface rounded-t-[10px] sm:rounded-[10px] border border-line max-h-[88dvh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-line">
          <span className="text-[13px] font-bold truncate">{recipe ? recipe.name : t("rec.new")}</span>
          <button onClick={onClose} className="p-1.5 -m-1 text-muted hover:bg-subtle rounded-[4px]"><Icon name="X" size={16} /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          <div>
            <FieldLabel>{t("rec.name")}</FieldLabel>
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <FieldLabel>{t("rec.summary")}</FieldLabel>
            <input className={inputCls} placeholder={t("rec.summaryHint")} value={summary} onChange={(e) => setSummary(e.target.value)} />
          </div>
          <div className="grid grid-cols-[1.6fr_1fr] gap-2.5">
            <div>
              <FieldLabel>{t("ing.composition")}</FieldLabel>
              <input className={inputCls + " mono"} value={composition} onChange={(e) => setComposition(e.target.value)} />
            </div>
            <div>
              <FieldLabel>{t("ing.bandGap")}</FieldLabel>
              <input className={inputCls + " mono"} value={bandGap} onChange={(e) => setBandGap(e.target.value)} />
            </div>
          </div>
          <div>
            <FieldLabel>{t("rec.components")}</FieldLabel>
            <div className="space-y-1.5">
              {components.map((c, i) => (
                <div key={i} className="grid grid-cols-[1.4fr_1fr_auto] gap-1.5">
                  <input className={inputCls} placeholder={t("rec.component")} value={c.material}
                    onChange={(e) => setComponents((cs) => cs.map((x, j) => (j === i ? { ...x, material: e.target.value } : x)))} />
                  <input className={inputCls + " mono"} placeholder={t("rec.amount")} value={c.amount}
                    onChange={(e) => setComponents((cs) => cs.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
                  <button onClick={() => setComponents((cs) => cs.filter((_, j) => j !== i))} className="p-1.5 text-muted hover:text-danger">
                    <Icon name="X" size={13} />
                  </button>
                </div>
              ))}
              <button onClick={() => setComponents((cs) => [...cs, { material: "", amount: "" }])}
                className="text-[11px] font-semibold text-brand-deep flex items-center gap-1">
                <Icon name="Plus" size={11} /> {t("rec.addComponent")}
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <FieldLabel>{t("rec.solvents")}</FieldLabel>
              <input className={inputCls + " mono"} placeholder="DMF:DMSO 4:1" value={solvents} onChange={(e) => setSolvents(e.target.value)} />
            </div>
            <div>
              <FieldLabel>{t("rec.concentration")}</FieldLabel>
              <input className={inputCls + " mono"} placeholder="1.4 M" value={concentration} onChange={(e) => setConcentration(e.target.value)} />
            </div>
          </div>
          <div>
            <FieldLabel>{t("rec.procedure")}</FieldLabel>
            <textarea className={inputCls + " resize-none"} rows={3} value={procedure} onChange={(e) => setProcedure(e.target.value)} />
          </div>
        </div>
        <div className="flex items-center gap-2 px-4 py-3 border-t border-line">
          {recipe && (
            <button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                await setRecipeArchived(recipe.id, true);
                setBusy(false);
                onSaved();
              }}
              className="text-[11.5px] font-semibold text-muted hover:text-danger"
            >
              {t("lib.archive")}
            </button>
          )}
          <span className="flex-1" />
          <button onClick={onClose} className="h-9 px-4 border border-line rounded-[4px] text-[12.5px] font-semibold text-charcoal">
            {t("insp.cancel")}
          </button>
          <button
            disabled={busy || !name.trim()}
            onClick={async () => {
              setBusy(true);
              await saveRecipe(recipe?.id ?? null, {
                name, summary,
                // Spread the stored payload first so ingested fields with no
                // editor here (e.g. source notes) survive a save.
                payload: {
                  ...(recipe?.payload ?? {}),
                  components, solvents, concentration, procedure, composition, bandGap,
                },
              });
              setBusy(false);
              onSaved();
            }}
            className="h-9 px-4 bg-brand text-[#243000] rounded-[4px] text-[12.5px] font-bold disabled:opacity-50"
          >
            {t("insp.save")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------- Category manager ----------------
//
// Material admins define the lab's own categories: add, rename (EN + 中文),
// reorder, and delete (materials move to a category you choose).

function CategoryManager({
  categories, onClose, onChanged,
}: {
  categories: CategoryRow[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState("");
  const [newZh, setNewZh] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editZh, setEditZh] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [moveTo, setMoveTo] = useState("");
  const [error, setError] = useState("");

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-ink/30 flex items-end sm:items-center justify-center p-0 sm:p-6" onClick={onClose}>
      <div
        className="w-full sm:max-w-lg bg-surface rounded-t-[10px] sm:rounded-[10px] border border-line max-h-[88dvh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-line">
          <span className="text-[13px] font-bold">{t("mat.categories")}</span>
          <button onClick={onClose} className="p-1.5 -m-1 text-muted hover:bg-subtle rounded-[4px]">
            <Icon name="X" size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {categories.map((c, i) => (
            <div key={c.id} className="border border-line rounded-[5px] px-2.5 py-2">
              {editing === c.id ? (
                <div className="space-y-1.5">
                  <input className={inputCls} value={editName} onChange={(e) => setEditName(e.target.value)} autoFocus />
                  <input className={inputCls} placeholder="中文名称" value={editZh} onChange={(e) => setEditZh(e.target.value)} />
                  <div className="flex justify-end gap-1.5">
                    <button onClick={() => setEditing(null)} className="text-[11.5px] font-semibold text-muted px-2 py-1">
                      {t("insp.cancel")}
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => run(async () => { await renameMaterialCategory(c.id, editName, editZh); setEditing(null); })}
                      className="bg-ink text-white rounded-[4px] px-3 py-1 text-[11.5px] font-semibold"
                    >
                      {t("insp.save")}
                    </button>
                  </div>
                </div>
              ) : deleting === c.id ? (
                <div className="space-y-1.5">
                  <p className="text-[11.5px] font-semibold text-warn">{t("mat.catDeleteQ")}</p>
                  <select
                    className="h-9 w-full border border-line rounded-[4px] px-2 text-[12.5px] bg-surface"
                    value={moveTo}
                    onChange={(e) => setMoveTo(e.target.value)}
                  >
                    <option value="">{t("mat.catMoveTo")}</option>
                    {categories.filter((x) => x.id !== c.id).map((x) => (
                      <option key={x.id} value={x.code}>{x.name}</option>
                    ))}
                  </select>
                  <div className="flex justify-end gap-1.5">
                    <button onClick={() => setDeleting(null)} className="text-[11.5px] font-semibold text-muted px-2 py-1">
                      {t("insp.cancel")}
                    </button>
                    <button
                      disabled={busy || !moveTo}
                      onClick={() => run(async () => { await deleteMaterialCategory(c.id, moveTo); setDeleting(null); })}
                      className="bg-danger text-white rounded-[4px] px-3 py-1 text-[11.5px] font-semibold disabled:opacity-50"
                    >
                      {t("mat.catDelete")}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <div className="flex flex-col">
                    <button
                      disabled={busy || i === 0}
                      onClick={() => run(() => moveMaterialCategory(c.id, "up"))}
                      className="text-muted disabled:opacity-25 hover:text-ink"
                    >
                      <Icon name="ChevronUp" size={12} />
                    </button>
                    <button
                      disabled={busy || i === categories.length - 1}
                      onClick={() => run(() => moveMaterialCategory(c.id, "down"))}
                      className="text-muted disabled:opacity-25 hover:text-ink"
                    >
                      <Icon name="ChevronDown" size={12} />
                    </button>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[12.5px] font-semibold truncate">{c.name}</div>
                    <div className="text-[10.5px] text-muted truncate">
                      {c.nameZh || "—"} · <span className="mono">{c.code}</span>
                    </div>
                  </div>
                  <button
                    onClick={() => { setEditing(c.id); setEditName(c.name); setEditZh(c.nameZh); }}
                    className="text-[11px] font-semibold text-brand-deep shrink-0"
                  >
                    {t("lib.edit")}
                  </button>
                  <button
                    onClick={() => { setDeleting(c.id); setMoveTo(""); }}
                    className="text-muted hover:text-danger shrink-0"
                  >
                    <Icon name="Trash2" size={13} />
                  </button>
                </div>
              )}
            </div>
          ))}
          {error && <p className="text-[12px] text-danger">{error}</p>}
        </div>

        <div className="border-t border-line p-4">
          <FieldLabel>{t("mat.catNew")}</FieldLabel>
          <div className="flex flex-wrap gap-1.5">
            <input className={inputCls + " flex-1 min-w-32"} placeholder={t("mat.catNamePh")} value={newName} onChange={(e) => setNewName(e.target.value)} />
            <input className={inputCls + " flex-1 min-w-28"} placeholder="中文名称" value={newZh} onChange={(e) => setNewZh(e.target.value)} />
            <button
              disabled={busy || !newName.trim()}
              onClick={() => run(async () => { await createMaterialCategory(newName, newZh); setNewName(""); setNewZh(""); })}
              className="h-9 px-3.5 bg-brand text-[#243000] rounded-[4px] text-[12px] font-bold disabled:opacity-50 flex items-center gap-1"
            >
              <Icon name="Plus" size={13} /> {t("mat.add")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
