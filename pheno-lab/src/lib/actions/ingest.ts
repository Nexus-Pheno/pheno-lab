"use server";

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireSession, requireStaff, type Session } from "@/lib/auth";
import { assertSteward } from "@/lib/actions/stewardship";
import { nameKey, sameName, buildNameIndex, matchName } from "@/lib/name-match";
import type { MaterialCategory, RecipeComponent } from "@/lib/materials-meta";

// Ingestion quality gate. An agent (or a person) stages extracted facts as
// IngestItems; a manager/admin reviews, edits and publishes them into the
// live library. Nothing is published automatically.

export type IngestKind = "EQUIPMENT" | "MATERIAL" | "EXPERIMENT" | "FORMULA" | "ENVIRONMENT" | "PRESET";

export type EquipmentDraft = {
  name: string;
  make: string;
  model: string;
  assetTag: string;
  processName: string; // matched to a Process by name on publish
  locationName: string;
  parameters: { name: string; unit: string; defaultValue: string }[];
  notes: string;
};

export type MaterialDraft = {
  name: string;
  category: MaterialCategory;
  composition: string;
  smiles: string;
  casNumber: string;
  molecularWeight: string;
  purity: string;
  supplier: string;
  lot: string;
  properties: Record<string, string>;
  notes: string;
};

/** A perovskite ink/solution formula, published into the Recipe library. */
export type FormulaDraft = {
  name: string;
  summary: string; // public one-liner; contents stay behind recipe access
  composition: string; // ABX3 stoichiometry
  bandGap: string; // eV
  components: RecipeComponent[];
  solvents: string;
  concentration: string;
  procedure: string;
  notes: string;
};

/** A lab environment and the conditions recorded in it. */
export type EnvironmentDraft = {
  name: string;
  conditions: { name: string; unit: string; defaultValue: string }[];
  notes: string;
};

/**
 * A historical experiment batch recovered from an operator's master sheet.
 *
 * Not every experiment builds a device: a batch that coats a SAM and measures
 * its contact angle is a complete experiment with steps and a characterisation
 * but no J-V data. `samples[].metrics` is therefore free-form, and a draft with
 * no metrics at all is still valid.
 */
export type ExperimentDraft = {
  title: string;
  /** Folder-name owner, e.g. "Joey" — mapped to a real account on signup. */
  operator: string;
  /** LARGE = module work, SMALL = spin-coated cells, OTHER = characterisation only. */
  scale: "LARGE" | "SMALL" | "OTHER";
  batchLabel: string; // the sheet's 实验批次编号 / AI数据编号 prefix
  date: string; // YYYYMMDD as written
  campaign: string;
  hypothesis: string; // 实验目的
  problem: string; // 实验设计DOE
  conclusion: string; // 实验结论
  observation: string; // 失效分析
  steps: {
    processName: string;
    name: string;
    parameters: { name: string; unit: string; value: string }[];
    materialNames: string[];
    recipeName: string;
  }[];
  characterizations: { processName: string; name: string }[];
  samples: {
    code: string;
    metrics: Record<string, string | number>;
    /** Absolute paths of the JV/instrument files that belong to this sample. */
    files: string[];
    note: string;
  }[];
  sourceFiles: string[];
};

/** A saved step configuration — a documented process recipe. */
export type PresetDraft = {
  name: string;
  processName: string; // matched to a Process by name on publish
  parameters: { name: string; unit: string; value: string }[];
  notes: string;
};

async function assertReviewer(): Promise<Session> {
  // Managers and admins run the quality gate; technicians cannot publish.
  return requireStaff();
}

export async function listIngestItems() {
  const session = await requireSession();
  return db.ingestItem.findMany({
    where: { organizationId: session.org },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    include: { reviewedBy: { select: { name: true } } },
  });
}

/** Stage extracted facts for review (used by the agent intake script). */
export async function stageIngestItem(data: {
  kind: IngestKind;
  title: string;
  sourceFile?: string;
  confidence?: string;
  payload: Record<string, unknown>;
}) {
  const session = await assertReviewer();
  return db.ingestItem.create({
    data: {
      organizationId: session.org,
      kind: data.kind,
      title: data.title,
      sourceFile: data.sourceFile ?? "",
      confidence: data.confidence ?? "",
      payload: data.payload as Prisma.InputJsonValue,
    },
  });
}

/**
 * One item's full payload, fetched only when the reviewer opens it.
 *
 * The queue list deliberately does NOT carry payloads: a single imported
 * experiment holds hundreds of samples, so sending every payload to the
 * browser made the page unusable once real data arrived.
 */
export async function getIngestPayload(id: string): Promise<Record<string, unknown>> {
  const session = await requireSession();
  const item = await db.ingestItem.findFirst({
    where: { id, organizationId: session.org },
    select: { payload: true },
  });
  return (item?.payload ?? {}) as Record<string, unknown>;
}

/** Save reviewer edits without publishing. */
export async function updateIngestPayload(id: string, payload: Record<string, unknown>, reviewNote: string) {
  const session = await assertReviewer();
  await db.ingestItem.updateMany({
    where: { id, organizationId: session.org, status: "PENDING" },
    data: { payload: payload as Prisma.InputJsonValue, reviewNote },
  });
}

export async function rejectIngestItem(id: string, reviewNote: string) {
  const session = await assertReviewer();
  await db.ingestItem.updateMany({
    where: { id, organizationId: session.org, status: "PENDING" },
    data: { status: "REJECTED", reviewNote, reviewedAt: new Date(), reviewedById: session.uid },
  });
}

/**
 * How the reviewer resolved a duplicate. UPDATE writes onto the existing
 * record; CREATE_ANYWAY is a deliberate second copy and must be chosen
 * explicitly — a plain approve can never create one by accident.
 */
export type PublishResolution =
  | { mode: "AUTO" }
  | { mode: "UPDATE"; targetId: string }
  | { mode: "CREATE_ANYWAY" };

/** Merge for updates: a blank incoming value never erases a stored one. */
function mergeKeep<T extends Record<string, unknown>>(incoming: T, existing: T): T {
  const out = { ...existing } as Record<string, unknown>;
  for (const [k, v] of Object.entries(incoming)) {
    const blank =
      v === undefined ||
      v === null ||
      (typeof v === "string" && v.trim() === "") ||
      (Array.isArray(v) && v.length === 0) ||
      (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0);
    if (!blank) out[k] = v;
  }
  return out as T;
}

/** Approve → write the reviewed facts into the live library. */
export async function publishIngestItem(
  id: string,
  payload: Record<string, unknown>,
  reviewNote: string,
  resolution: PublishResolution = { mode: "AUTO" }
) {
  const session = await assertReviewer();
  const item = await db.ingestItem.findFirst({ where: { id, organizationId: session.org, status: "PENDING" } });
  if (!item) throw new Error("Item not found or already reviewed.");

  // Nothing enters the library without the duplicate question being answered.
  if (resolution.mode === "AUTO") {
    const dups = (await findDuplicates(item.kind as IngestKind, payload, id)).filter((d) => d.source === "LIBRARY");
    if (dups.length > 0) {
      throw new Error(
        `This matches ${dups.length === 1 ? "an existing record" : `${dups.length} existing records`} (${dups
          .map((d) => d.name)
          .join(", ")}). Choose whether to update it or skip this item.`
      );
    }
  }
  const updateTargetId = resolution.mode === "UPDATE" ? resolution.targetId : null;

  let publishedId: string | null = null;

  if (item.kind === "MATERIAL") {
    const d = payload as unknown as MaterialDraft;
    if (!d.name?.trim()) throw new Error("Material name is required.");
    // Only an explicitly chosen target is updated; otherwise this is new.
    const existing = updateTargetId
      ? await db.material.findFirst({ where: { id: updateTargetId, organizationId: session.org } })
      : null;
    if (updateTargetId && !existing) throw new Error("The material to update no longer exists.");
    const data = {
      name: d.name.trim(),
      category: d.category ?? "OTHER",
      composition: d.composition ?? "",
      smiles: d.smiles ?? "",
      casNumber: d.casNumber ?? "",
      molecularWeight: d.molecularWeight ?? "",
      purity: d.purity ?? "",
      supplier: d.supplier ?? "",
      lot: d.lot ?? "",
      properties: (d.properties ?? {}) as Prisma.InputJsonValue,
      notes: d.notes ?? "",
    };
    const rec = existing
      ? await db.material.update({
          where: { id: existing.id },
          data: mergeKeep(data, {
            name: existing.name,
            category: existing.category,
            composition: existing.composition,
            smiles: existing.smiles,
            casNumber: existing.casNumber,
            molecularWeight: existing.molecularWeight,
            purity: existing.purity,
            supplier: existing.supplier,
            lot: existing.lot,
            properties: (existing.properties ?? {}) as Prisma.InputJsonValue,
            notes: existing.notes,
          }),
        })
      : await db.material.create({ data: { ...data, organizationId: session.org } });
    publishedId = rec.id;
  } else if (item.kind === "EQUIPMENT") {
    const d = payload as unknown as EquipmentDraft;
    if (!d.name?.trim()) throw new Error("Equipment name is required.");
    // Match the process/location by name; both are required context for equipment.
    const process = d.processName
      ? await db.process.findFirst({ where: { organizationId: session.org, name: d.processName } })
      : null;
    // Equipment must belong to a process — the reviewer picks a valid one.
    if (!process) throw new Error("Pick an existing process for this equipment before publishing.");
    let locationId: string | null = null;
    if (d.locationName?.trim()) {
      const loc = await db.location.findFirst({
        where: { organizationId: session.org, name: d.locationName.trim() },
      });
      locationId = loc?.id ?? (await db.location.create({
        data: { organizationId: session.org, name: d.locationName.trim() },
      })).id;
    }
    const equipData = {
      processId: process.id,
      name: d.name.trim(),
      make: d.make ?? "",
      model: d.model ?? "",
      assetTag: d.assetTag ?? "",
      locationId,
      parameters: (d.parameters ?? []) as Prisma.InputJsonValue,
    };
    const existingEquip = updateTargetId
      ? await db.equipment.findFirst({ where: { id: updateTargetId, organizationId: session.org } })
      : null;
    if (updateTargetId && !existingEquip) throw new Error("The equipment to update no longer exists.");
    const rec = existingEquip
      ? await db.equipment.update({ where: { id: existingEquip.id }, data: equipData })
      : await db.equipment.create({ data: { ...equipData, organizationId: session.org } });
    publishedId = rec.id;
  } else if (item.kind === "FORMULA") {
    // Formulas are proprietary — publishing one needs recipe access, not just
    // staff.
    await assertSteward("recipeAccess");
    const d = payload as unknown as FormulaDraft;
    const name = d.name?.trim();
    if (!name) throw new Error("Formula name is required.");
    const components = (d.components ?? [])
      .filter((c) => c.material?.trim())
      .map((c) => ({
        material: c.material.trim(),
        amount: (c.amount ?? "").trim(),
        role: (c.role ?? "").trim(),
      }));
    if (components.length === 0) throw new Error("A formula needs at least one component.");
    const data = {
      name,
      summary: (d.summary ?? "").trim(),
      payload: {
        components,
        solvents: d.solvents ?? "",
        concentration: d.concentration ?? "",
        procedure: d.procedure ?? "",
        composition: d.composition ?? "",
        bandGap: d.bandGap ?? "",
        notes: d.notes ?? "",
      } as Prisma.InputJsonValue,
    };
    const existing = updateTargetId
      ? await db.recipe.findFirst({ where: { id: updateTargetId, organizationId: session.org } })
      : null;
    if (updateTargetId && !existing) throw new Error("The recipe to update no longer exists.");
    const rec = existing
      ? await db.recipe.update({ where: { id: existing.id }, data })
      : await db.recipe.create({
          data: { ...data, organizationId: session.org, createdById: session.uid },
        });
    publishedId = rec.id;
  } else if (item.kind === "ENVIRONMENT") {
    const d = payload as unknown as EnvironmentDraft;
    if (!d.name?.trim()) throw new Error("Environment name is required.");
    const conditions = (d.conditions ?? [])
      .filter((c) => c.name?.trim())
      .map((c) => ({
        name: c.name.trim(),
        unit: (c.unit ?? "").trim(),
        defaultValue: (c.defaultValue ?? "").trim(),
      }));
    const envData = { name: d.name.trim(), conditions: conditions as Prisma.InputJsonValue };
    const existing = updateTargetId
      ? await db.labEnvironment.findFirst({ where: { id: updateTargetId, organizationId: session.org } })
      : null;
    if (updateTargetId && !existing) throw new Error("The environment to update no longer exists.");
    const rec = existing
      ? await db.labEnvironment.update({ where: { id: existing.id }, data: envData })
      : await db.labEnvironment.create({ data: { ...envData, organizationId: session.org } });
    publishedId = rec.id;
  } else if (item.kind === "PRESET") {
    const d = payload as unknown as PresetDraft;
    if (!d.name?.trim()) throw new Error("Preset name is required.");
    // A preset is a saved configuration OF a process, so the process must exist.
    const process = d.processName
      ? await db.process.findFirst({ where: { organizationId: session.org, name: d.processName } })
      : null;
    if (!process) throw new Error("Pick an existing process for this preset before publishing.");
    const parameters = (d.parameters ?? [])
      .filter((p) => p.name?.trim())
      .map((p) => ({
        name: p.name.trim(),
        unit: (p.unit ?? "").trim(),
        value: (p.value ?? "").trim(),
        source: "process",
      }));
    // Same payload shape the designer saves, so an ingested preset applies
    // exactly like a hand-made one. Equipment and environment are left unset —
    // the reviewer picks those in the designer when the preset is used.
    const presetPayload = { materials: [], parameters } as Prisma.InputJsonValue;
    const existing = updateTargetId
      ? await db.preset.findFirst({ where: { id: updateTargetId, organizationId: session.org } })
      : null;
    if (updateTargetId && !existing) throw new Error("The preset to update no longer exists.");
    const rec = existing
      ? await db.preset.update({
          where: { id: existing.id },
          data: { name: d.name.trim(), processId: process.id, payload: presetPayload },
        })
      : await db.preset.create({
          data: {
            organizationId: session.org,
            kind: "STEP",
            processId: process.id,
            name: d.name.trim(),
            payload: presetPayload,
            createdById: session.uid,
          },
        });
    publishedId = rec.id;
  } else {
    publishedId = await publishExperiment(session, payload as unknown as ExperimentDraft);
  }

  await db.ingestItem.update({
    where: { id },
    data: {
      status: "PUBLISHED",
      payload: payload as Prisma.InputJsonValue,
      reviewNote,
      reviewedAt: new Date(),
      reviewedById: session.uid,
      publishedId,
    },
  });
}

// ---- Historical experiments ----

/**
 * The operator who ran a historical batch, as a real (but inactive) account.
 *
 * The source folders carry only a name — "joey" — so each becomes an inactive
 * user that owns their imported work. When that person registers with their
 * real address an admin merges the two; until then nobody can sign in as them.
 */
async function operatorUser(session: Session, operator: string) {
  const name = operator.trim();
  if (!name) throw new Error("The experiment needs an operator.");
  const existing = await db.user.findFirst({
    where: { organizationId: session.org, name },
  });
  if (existing) return existing;
  const org = await db.organization.findUniqueOrThrow({ where: { id: session.org } });
  const last = await db.user.findFirst({
    where: { organizationId: session.org },
    orderBy: { userNumber: "desc" },
    select: { userNumber: true },
  });
  return db.user.create({
    data: {
      organizationId: session.org,
      name,
      // Clearly-marked placeholder: unique, undeliverable, and obviously not real.
      email: `${name.toLowerCase().replace(/[^a-z0-9]/g, "")}@imported.${org.slug}.invalid`,
      passwordHash: "",
      active: false,
      role: "TECHNICIAN",
      userNumber: (last?.userNumber ?? 0) + 1,
    },
  });
}

/** Build the whole experiment graph in one transaction. */
async function publishExperiment(session: Session, d: ExperimentDraft): Promise<string> {
  if (!d.title?.trim()) throw new Error("The experiment needs a title.");
  const owner = await operatorUser(session, d.operator);

  // Resolve library references by name up front — a miss is left unlinked
  // rather than invented, and shows up in the review form as a warning.
  const processes = await db.process.findMany({
    where: { organizationId: session.org, archived: false },
    select: { id: true, name: true, kind: true, defaultLayer: true },
  });
  const procIndex = buildNameIndex(processes);
  const materials = await db.material.findMany({
    where: { organizationId: session.org, archived: false },
    select: { id: true, name: true },
  });
  const matIndex = buildNameIndex(materials);
  const recipes = await db.recipe.findMany({
    where: { organizationId: session.org, archived: false },
    select: { id: true, name: true },
  });
  const recipeIndex = buildNameIndex(recipes);

  const year = (d.date || "").slice(0, 4) || String(new Date().getFullYear());
  const org = await db.organization.findUniqueOrThrow({ where: { id: session.org } });
  const seq = owner.nextExpSeq;
  const code = `${year}-${String(org.orgNumber).padStart(3, "0")}-${owner.userNumber}-${seq}`;

  return db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: owner.id }, data: { nextExpSeq: seq + 1 } });

    const exp = await tx.experiment.create({
      data: {
        organizationId: session.org,
        code,
        title: d.title.trim().slice(0, 200),
        campaign: d.campaign ?? "",
        // Historical work is finished work — it goes straight to COMPLETE so it
        // never appears in the lab's active queue.
        status: "COMPLETE",
        hypothesis: d.hypothesis ?? "",
        problem: d.problem ?? "",
        conclusion: d.conclusion ?? "",
        observation: d.observation ?? "",
        createdById: owner.id,
        metadata: {
          imported: true,
          operator: d.operator,
          scale: d.scale,
          batchLabel: d.batchLabel,
          sourceDate: d.date,
          sourceFiles: d.sourceFiles ?? [],
        } as Prisma.InputJsonValue,
      },
    });

    // --- process steps
    let pos = 0;
    for (const s of d.steps ?? []) {
      const proc = matchName(s.processName, procIndex);
      if (!proc) continue; // unmatched process → skip rather than guess
      const step = await tx.processStep.create({
        data: {
          experimentId: exp.id,
          position: pos++,
          processId: proc.id,
          name: (s.name || proc.name).slice(0, 200),
          layer: proc.defaultLayer ?? "",
          recipeId: s.recipeName ? matchName(s.recipeName, recipeIndex)?.id ?? null : null,
        },
      });
      let pp = 0;
      for (const p of s.parameters ?? []) {
        if (!p.name?.trim()) continue;
        await tx.stepParameter.create({
          data: {
            stepId: step.id,
            position: pp++,
            name: p.name.trim(),
            unit: p.unit ?? "",
            value: String(p.value ?? ""),
            source: "process",
          },
        });
      }
      let mp = 0;
      const used = new Set<string>();
      for (const nm of s.materialNames ?? []) {
        const mat = matchName(nm, matIndex);
        if (!mat || used.has(mat.id)) continue;
        used.add(mat.id);
        await tx.stepMaterial.create({
          data: { stepId: step.id, materialId: mat.id, amount: "", position: mp++ },
        });
      }
    }

    // --- samples
    const sampleIds: Record<string, string> = {};
    let sn = 0;
    for (const s of d.samples ?? []) {
      const codeStr = (s.code || `S${sn + 1}`).slice(0, 100);
      if (sampleIds[codeStr]) continue; // same sample listed twice in the sheet
      const row = await tx.sample.create({
        data: { experimentId: exp.id, code: codeStr, note: s.note ?? "" },
      });
      sampleIds[codeStr] = row.id;
      sn++;
    }

    // --- characterisations and their per-sample results
    let cpos = 0;
    for (const c of d.characterizations ?? []) {
      const proc = matchName(c.processName, procIndex);
      if (!proc) continue;
      const ch = await tx.characterization.create({
        data: {
          experimentId: exp.id,
          position: cpos++,
          processId: proc.id,
          name: (c.name || proc.name).slice(0, 200),
        },
      });
      for (const s of d.samples ?? []) {
        const sid = sampleIds[(s.code || "").slice(0, 100)];
        if (!sid) continue;
        const metrics = s.metrics ?? {};
        if (Object.keys(metrics).length === 0 && (s.files ?? []).length === 0) continue;
        const res = await tx.characterizationResult.create({
          data: {
            characterizationId: ch.id,
            sampleId: sid,
            metrics: metrics as Prisma.InputJsonValue,
            note: "",
            source: "IMPORT",
          },
        });
        // The raw instrument files stay referenced against the batch so they
        // can be traced back later, even when only the metrics were parsed.
        for (const f of s.files ?? []) {
          await tx.attachment.create({
            data: {
              fileName: f.split("/").pop() ?? f,
              storedPath: f,
              mime: f.toLowerCase().endsWith(".csv") ? "text/csv" : "application/octet-stream",
              size: 0,
              characterizationResultId: res.id,
            },
          });
        }
      }
    }

    return exp.id;
  }, { timeout: 120_000 });
}

// ---- Duplicate detection ----
//
// Only genuinely new facts should enter the library. Before anything is
// published every staged item is checked against the live library AND against
// the rest of the queue, so a reviewer sees the collision and decides: update
// the existing record, skip the item, or (deliberately) create a second one.

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
  fields: [key: string, label: string][]
): FieldDiff[] {
  const out: FieldDiff[] = [];
  for (const [key, label] of fields) {
    const a = str(incoming[key]);
    const b = str(existing[key]);
    // An empty incoming value is "no new information", not a difference.
    if (!a) continue;
    if (nameKey(a) !== nameKey(b)) out.push({ field: label, existing: b, incoming: a });
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
      .replace(/\.(?=\D|$)/g, "")
  );
}

function componentSummary(payload: Record<string, unknown>): string {
  const comps = Array.isArray(payload.components) ? (payload.components as RecipeComponent[]) : [];
  return comps
    .filter((c) => c?.material?.trim())
    .map((c) => `${c.material.trim()} ${str(c.amount)}`.trim())
    .join(", ");
}

/** Everything already in the library (or the queue) that this item may duplicate. */
export async function findDuplicates(
  kind: IngestKind,
  payload: Record<string, unknown>,
  selfId?: string
): Promise<DuplicateCandidate[]> {
  const session = await requireSession();
  const org = session.org;
  const name = str(payload.name);
  const found: DuplicateCandidate[] = [];

  if (kind === "MATERIAL") {
    const cas = str(payload.casNumber);
    const rows = await db.material.findMany({
      where: { organizationId: org, archived: false },
      select: { id: true, name: true, casNumber: true, composition: true, smiles: true, molecularWeight: true, category: true, supplier: true },
    });
    for (const r of rows) {
      const byName = name && sameName(name, r.name);
      const byCas = !!cas && !!r.casNumber && nameKey(cas) === nameKey(r.casNumber);
      if (!byName && !byCas) continue;
      const differences = diffFields(payload, r as unknown as Record<string, unknown>, [
        ["name", "Name"],
        ["category", "Category"],
        ["composition", "Formula"],
        ["smiles", "SMILES"],
        ["casNumber", "CAS"],
        ["molecularWeight", "Molecular weight"],
        ["supplier", "Supplier"],
      ]);
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
        !!composition && !!str(p.composition) && compositionKey(composition) === compositionKey(str(p.composition));
      if (!byName && !byComp) continue;
      const differences = diffFields(payload, { ...p, name: r.name, summary: r.summary }, [
        ["name", "Name"],
        ["composition", "Composition"],
        ["bandGap", "Band gap"],
        ["concentration", "Concentration"],
        ["solvents", "Solvent system"],
      ]);
      const incomingComps = componentSummary(payload);
      const existingComps = componentSummary(p);
      if (incomingComps && nameKey(incomingComps) !== nameKey(existingComps)) {
        differences.push({ field: "Components", existing: existingComps, incoming: incomingComps });
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
      const byTag = !!assetTag && !!r.assetTag && nameKey(assetTag) === nameKey(r.assetTag);
      const byModel =
        !!str(payload.model) && !!r.model &&
        nameKey(str(payload.make)) === nameKey(r.make) &&
        nameKey(str(payload.model)) === nameKey(r.model);
      if (!byName && !byTag && !byModel) continue;
      const differences = diffFields(payload, r as unknown as Record<string, unknown>, [
        ["name", "Name"],
        ["make", "Manufacturer"],
        ["model", "Model"],
        ["assetTag", "Asset tag"],
      ]);
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
        if (str(payload.date) && str(meta.sourceDate) && str(meta.sourceDate) !== str(payload.date)) continue;
        const differences = diffFields(payload, { title: r.title }, [["title", "Title"]]);
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
      if (incoming.length && nameKey(fmt(incoming)) !== nameKey(fmt(existingConds))) {
        differences.push({ field: "Conditions", existing: fmt(existingConds), incoming: fmt(incoming) });
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
      const differences = diffFields(payload, { name: r.name, processName: r.process.name }, [
        ["name", "Name"],
        ["processName", "Process"],
      ]);
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
      compositionKey(str(payload.composition)) === compositionKey(str(other.composition));
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

export type BulkPublishResult = {
  id: string;
  title: string;
  outcome: "PUBLISHED" | "HELD" | "ERROR";
  message: string;
};

/**
 * Approve many items in one pass — for a large intake where opening each one
 * is impractical.
 *
 * Bulk approval is NOT a way around the duplicate gate: anything that matches
 * an existing record is held back and reported, never published. Items are
 * processed one at a time (not concurrently) so that two duplicates inside the
 * same batch can't both pass the check and both get created — the first
 * publishes, the second then sees it and is held.
 */
export async function publishIngestItems(ids: string[]): Promise<BulkPublishResult[]> {
  const session = await assertReviewer();
  const items = await db.ingestItem.findMany({
    where: { id: { in: ids }, organizationId: session.org, status: "PENDING" },
  });

  // Materials first, so a formula's components resolve against them in the
  // library view straight after the run.
  const order: Record<string, number> = { MATERIAL: 0, EQUIPMENT: 1, FORMULA: 2, EXPERIMENT: 3 };
  items.sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9));

  const results: BulkPublishResult[] = [];
  for (const item of items) {
    const payload = (item.payload ?? {}) as Record<string, unknown>;
    try {
      const dups = (await findDuplicates(item.kind as IngestKind, payload, item.id)).filter(
        (d) => d.source === "LIBRARY"
      );
      if (dups.length > 0) {
        results.push({
          id: item.id,
          title: item.title,
          outcome: "HELD",
          message: dups.map((d) => d.name).join(", "),
        });
        continue;
      }
      await publishIngestItem(item.id, payload, item.reviewNote);
      results.push({ id: item.id, title: item.title, outcome: "PUBLISHED", message: "" });
    } catch (e) {
      results.push({
        id: item.id,
        title: item.title,
        outcome: "ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return results;
}

/**
 * Resolve held-back duplicates in one go. REPLACE overwrites the matched
 * library record with the staged facts; SKIP closes the item as a duplicate
 * (kept in history); DELETE removes it from the queue entirely.
 */
export type DuplicateAction = "REPLACE" | "SKIP" | "DELETE";

export async function resolveDuplicates(
  ids: string[],
  action: DuplicateAction
): Promise<BulkPublishResult[]> {
  const session = await assertReviewer();
  const items = await db.ingestItem.findMany({
    where: { id: { in: ids }, organizationId: session.org, status: "PENDING" },
  });

  const results: BulkPublishResult[] = [];
  for (const item of items) {
    const payload = (item.payload ?? {}) as Record<string, unknown>;
    try {
      if (action === "DELETE") {
        await db.ingestItem.deleteMany({ where: { id: item.id, organizationId: session.org } });
        results.push({ id: item.id, title: item.title, outcome: "PUBLISHED", message: "" });
        continue;
      }

      const dups = (await findDuplicates(item.kind as IngestKind, payload, item.id)).filter(
        (d) => d.source === "LIBRARY"
      );

      if (action === "SKIP") {
        await markIngestDuplicate(item.id, item.reviewNote, dups[0]?.id);
        results.push({ id: item.id, title: item.title, outcome: "PUBLISHED", message: "" });
        continue;
      }

      // REPLACE: overwrite the single matched record. An ambiguous match is
      // left for a human — we never guess which of several records to edit.
      if (dups.length === 0) {
        await publishIngestItem(item.id, payload, item.reviewNote);
      } else if (dups.length === 1) {
        await publishIngestItem(item.id, payload, item.reviewNote, { mode: "UPDATE", targetId: dups[0].id });
      } else {
        results.push({
          id: item.id,
          title: item.title,
          outcome: "HELD",
          message: dups.map((d) => d.name).join(", "),
        });
        continue;
      }
      results.push({ id: item.id, title: item.title, outcome: "PUBLISHED", message: "" });
    } catch (e) {
      results.push({
        id: item.id,
        title: item.title,
        outcome: "ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return results;
}

/** Close an item as a duplicate of something that already exists. */
export async function markIngestDuplicate(id: string, reviewNote: string, targetId?: string) {
  const session = await assertReviewer();
  await db.ingestItem.updateMany({
    where: { id, organizationId: session.org, status: "PENDING" },
    data: {
      status: "DUPLICATE",
      reviewNote,
      reviewedAt: new Date(),
      reviewedById: session.uid,
      publishedId: targetId ?? null,
    },
  });
}

export async function deleteIngestItem(id: string) {
  const session = await assertReviewer();
  await db.ingestItem.deleteMany({ where: { id, organizationId: session.org } });
}
