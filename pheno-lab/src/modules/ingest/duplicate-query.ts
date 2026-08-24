import "server-only";

import { db } from "@/infrastructure/db/client";
import type { RecipeComponent } from "@/lib/materials-meta";
import { nameKey, sameName } from "@/lib/name-match";
import type { Actor } from "@/modules/authorization/actor";
import {
  ingestIdSchema,
  ingestKindSchema,
  ingestPayloadSchema,
} from "./schema";

export type FieldDiff = { field: string; existing: string; incoming: string };

export type DuplicateCandidate = {
  id: string;
  name: string;
  /** What gave it away — a name, a CAS number, an asset tag, a composition. */
  matchedOn: string;
  /** Where it lives: the live library, or another item still in the queue. */
  source: "LIBRARY" | "QUEUE";
  differences: FieldDiff[];
  /** No differences at all — publishing would add nothing. */
  identical: boolean;
};

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v);
}

/** Compare incoming fields against an existing record, ignoring blanks. */
function diffFields(
  incoming: Record<string, unknown>,
  existing: Record<string, unknown>,
  fields: [key: string, label: string][],
): FieldDiff[] {
  const out: FieldDiff[] = [];
  for (const [key, label] of fields) {
    const a = str(incoming[key]);
    const b = str(existing[key]);
    // An empty incoming value is "no new information", not a difference.
    if (!a) continue;
    if (nameKey(a) !== nameKey(b))
      out.push({ field: label, existing: b, incoming: a });
  }
  return out;
}

/**
 * Comparison key for a chemical composition. Beyond the usual normalization
 * this equates full-width brackets with ASCII ones and trims meaningless
 * trailing zeros, so "Cs0.05MA0.10FA0.85PbI3" and "Cs0.05MA0.1FA0.85PbI3"
 * are recognised as the same absorber — real sheets write both.
 */
function compositionKey(s: string): string {
  return nameKey(
    str(s)
      .replace(/[（）]/g, (c) => (c === "（" ? "(" : ")"))
      .replace(/(\d*\.\d*?)0+(?=\D|$)/g, "$1")
      .replace(/\.(?=\D|$)/g, ""),
  );
}

function componentSummary(payload: Record<string, unknown>): string {
  const comps = Array.isArray(payload.components)
    ? (payload.components as RecipeComponent[])
    : [];
  return comps
    .filter((c) => c?.material?.trim())
    .map((c) => `${c.material.trim()} ${str(c.amount)}`.trim())
    .join(", ");
}

/** Everything already in the library (or the queue) that this item may duplicate. */
export async function findDuplicates(
  actor: Actor,
  rawKind: unknown,
  rawPayload: unknown,
  rawSelfId?: unknown,
): Promise<DuplicateCandidate[]> {
  const kind = ingestKindSchema.parse(rawKind);
  const payload = ingestPayloadSchema.parse(rawPayload);
  const selfId = rawSelfId ? ingestIdSchema.parse(rawSelfId) : undefined;
  const org = actor.org;
  const name = str(payload.name);
  const found: DuplicateCandidate[] = [];

  if (kind === "MATERIAL") {
    const cas = str(payload.casNumber);
    const rows = await db.material.findMany({
      where: { organizationId: org, archived: false },
      select: {
        id: true,
        name: true,
        casNumber: true,
        composition: true,
        smiles: true,
        molecularWeight: true,
        category: true,
        supplier: true,
      },
    });
    for (const r of rows) {
      const byName = name && sameName(name, r.name);
      const byCas =
        !!cas && !!r.casNumber && nameKey(cas) === nameKey(r.casNumber);
      if (!byName && !byCas) continue;
      const differences = diffFields(
        payload,
        r as unknown as Record<string, unknown>,
        [
          ["name", "Name"],
          ["category", "Category"],
          ["composition", "Formula"],
          ["smiles", "SMILES"],
          ["casNumber", "CAS"],
          ["molecularWeight", "Molecular weight"],
          ["supplier", "Supplier"],
        ],
      );
      found.push({
        id: r.id,
        name: r.name,
        matchedOn: byName ? "name" : "CAS number",
        source: "LIBRARY",
        differences,
        identical: differences.length === 0,
      });
    }
  } else if (kind === "FORMULA") {
    const composition = str(payload.composition);
    const rows = await db.recipe.findMany({
      where: { organizationId: org, archived: false },
      select: { id: true, name: true, summary: true, payload: true },
    });
    for (const r of rows) {
      const p = (r.payload ?? {}) as Record<string, unknown>;
      const byName = name && sameName(name, r.name);
      const byComp =
        !!composition &&
        !!str(p.composition) &&
        compositionKey(composition) === compositionKey(str(p.composition));
      if (!byName && !byComp) continue;
      const differences = diffFields(
        payload,
        { ...p, name: r.name, summary: r.summary },
        [
          ["name", "Name"],
          ["composition", "Composition"],
          ["bandGap", "Band gap"],
          ["concentration", "Concentration"],
          ["solvents", "Solvent system"],
        ],
      );
      const incomingComps = componentSummary(payload);
      const existingComps = componentSummary(p);
      if (incomingComps && nameKey(incomingComps) !== nameKey(existingComps)) {
        differences.push({
          field: "Components",
          existing: existingComps,
          incoming: incomingComps,
        });
      }
      found.push({
        id: r.id,
        name: r.name,
        matchedOn: byName ? "name" : "composition",
        source: "LIBRARY",
        differences,
        identical: differences.length === 0,
      });
    }
  } else if (kind === "EQUIPMENT") {
    const assetTag = str(payload.assetTag);
    const rows = await db.equipment.findMany({
      where: { organizationId: org, archived: false },
      select: { id: true, name: true, make: true, model: true, assetTag: true },
    });
    for (const r of rows) {
      const byName = name && sameName(name, r.name);
      const byTag =
        !!assetTag && !!r.assetTag && nameKey(assetTag) === nameKey(r.assetTag);
      const byModel =
        !!str(payload.model) &&
        !!r.model &&
        nameKey(str(payload.make)) === nameKey(r.make) &&
        nameKey(str(payload.model)) === nameKey(r.model);
      if (!byName && !byTag && !byModel) continue;
      const differences = diffFields(
        payload,
        r as unknown as Record<string, unknown>,
        [
          ["name", "Name"],
          ["make", "Manufacturer"],
          ["model", "Model"],
          ["assetTag", "Asset tag"],
        ],
      );
      found.push({
        id: r.id,
        name: r.name,
        matchedOn: byTag ? "asset tag" : byName ? "name" : "make and model",
        source: "LIBRARY",
        differences,
        identical: differences.length === 0,
      });
    }
  } else if (kind === "EXPERIMENT") {
    // A re-imported batch is recognised by operator + batch label + date,
    // which is what makes re-running an operator's folder safe.
    const op = str(payload.operator);
    const batch = str(payload.batchLabel);
    if (op && batch) {
      const rows = await db.experiment.findMany({
        where: { organizationId: org },
        select: { id: true, code: true, title: true, metadata: true },
      });
      for (const r of rows) {
        const meta = (r.metadata ?? {}) as Record<string, unknown>;
        if (!meta.imported) continue;
        if (nameKey(str(meta.operator)) !== nameKey(op)) continue;
        if (nameKey(str(meta.batchLabel)) !== nameKey(batch)) continue;
        if (
          str(payload.date) &&
          str(meta.sourceDate) &&
          str(meta.sourceDate) !== str(payload.date)
        )
          continue;
        const differences = diffFields(payload, { title: r.title }, [
          ["title", "Title"],
        ]);
        found.push({
          id: r.id,
          name: `${r.code} — ${r.title}`.slice(0, 90),
          matchedOn: "operator and batch",
          source: "LIBRARY",
          differences,
          identical: differences.length === 0,
        });
      }
    }
  } else if (kind === "ENVIRONMENT") {
    const rows = await db.labEnvironment.findMany({
      where: { organizationId: org, archived: false },
      select: { id: true, name: true, conditions: true },
    });
    for (const r of rows) {
      if (!name || !sameName(name, r.name)) continue;
      const incoming = Array.isArray(payload.conditions)
        ? (payload.conditions as { name: string; defaultValue: string }[])
        : [];
      const existingConds = Array.isArray(r.conditions)
        ? (r.conditions as { name: string; defaultValue: string }[])
        : [];
      const fmt = (cs: { name: string; defaultValue: string }[]) =>
        cs.map((c) => `${c.name} ${c.defaultValue ?? ""}`.trim()).join(", ");
      const differences: FieldDiff[] = [];
      if (
        incoming.length &&
        nameKey(fmt(incoming)) !== nameKey(fmt(existingConds))
      ) {
        differences.push({
          field: "Conditions",
          existing: fmt(existingConds),
          incoming: fmt(incoming),
        });
      }
      found.push({
        id: r.id,
        name: r.name,
        matchedOn: "name",
        source: "LIBRARY",
        differences,
        identical: differences.length === 0,
      });
    }
  } else if (kind === "PRESET") {
    const rows = await db.preset.findMany({
      where: { organizationId: org },
      select: { id: true, name: true, process: { select: { name: true } } },
    });
    for (const r of rows) {
      if (!name || !sameName(name, r.name)) continue;
      const differences = diffFields(
        payload,
        { name: r.name, processName: r.process.name },
        [
          ["name", "Name"],
          ["processName", "Process"],
        ],
      );
      found.push({
        id: r.id,
        name: `${r.name} (${r.process.name})`,
        matchedOn: "name",
        source: "LIBRARY",
        differences,
        identical: differences.length === 0,
      });
    }
  }

  // Collisions inside the queue itself — the same fact staged twice, which a
  // single source file can easily contain.
  const staged = await db.ingestItem.findMany({
    where: { organizationId: org, status: "PENDING", kind },
    select: { id: true, title: true, payload: true },
  });
  for (const s of staged) {
    if (selfId && s.id === selfId) continue;
    const other = (s.payload ?? {}) as Record<string, unknown>;
    const byName = !!name && sameName(name, str(other.name));
    const byCas =
      kind === "MATERIAL" &&
      !!str(payload.casNumber) &&
      nameKey(str(payload.casNumber)) === nameKey(str(other.casNumber));
    const byComp =
      kind === "FORMULA" &&
      !!str(payload.composition) &&
      compositionKey(str(payload.composition)) ===
        compositionKey(str(other.composition));
    if (!byName && !byCas && !byComp) continue;
    found.push({
      id: s.id,
      name: str(other.name) || s.title,
      matchedOn: byName ? "name" : byCas ? "CAS number" : "composition",
      source: "QUEUE",
      differences: [],
      identical: false,
    });
  }

  return found;
}
