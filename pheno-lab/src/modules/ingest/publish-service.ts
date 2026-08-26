import "server-only";

import { Prisma } from "@prisma/client";
import { db } from "@/infrastructure/db/client";
import { buildNameIndex, matchName } from "@/lib/name-match";
import type { Actor } from "@/modules/authorization/actor";
import { assertStaff } from "@/modules/authorization/policy";
import { recordUserAudit } from "@/modules/audit/writer";
import { assertStewardship } from "@/modules/stewardship/service";
import { findDuplicates } from "./duplicate-query";
import type {
  EnvironmentDraft,
  EquipmentDraft,
  ExperimentDraft,
  FormulaDraft,
  MaterialDraft,
  PresetDraft,
} from "./queue-service";
import {
  ingestIdSchema,
  ingestKindSchema,
  ingestPayloadSchema,
  ingestReviewNoteSchema,
  parseIngestDraft,
  publishResolutionSchema,
} from "./schema";

function assertReviewer(actor: Actor): void {
  assertStaff(actor);
}

/** The explicit decision applied when publishing a possible duplicate. */
export type PublishResolution =
  | { mode: "AUTO" }
  | { mode: "UPDATE"; targetId: string }
  | { mode: "CREATE_ANYWAY" };

/** Merge for updates: a blank incoming value never erases a stored one. */
function mergeKeep<T extends Record<string, unknown>>(
  incoming: T,
  existing: T,
): T {
  const out = { ...existing } as Record<string, unknown>;
  for (const [k, v] of Object.entries(incoming)) {
    const blank =
      v === undefined ||
      v === null ||
      (typeof v === "string" && v.trim() === "") ||
      (Array.isArray(v) && v.length === 0) ||
      (typeof v === "object" &&
        !Array.isArray(v) &&
        Object.keys(v as object).length === 0);
    if (!blank) out[k] = v;
  }
  return out as T;
}

/**
 * Attach already-uploaded documents to the record just published.
 *
 * Re-publishing an item, or updating an existing record, must not stack
 * duplicate rows — a reviewer who approves twice would otherwise double every
 * spec sheet — so keys already attached to this owner are skipped.
 */
async function attachDocuments(
  tx: Prisma.TransactionClient,
  owner: { equipmentId: string } | { labEnvironmentId: string },
  documents:
    | { fileName: string; storedPath: string; mime: string; size: number }[]
    | undefined,
) {
  if (!documents?.length) return;
  const attached = new Set(
    (
      await tx.attachment.findMany({
        where: owner,
        select: { storedPath: true },
      })
    ).map((a) => a.storedPath),
  );
  const fresh = documents.filter((doc) => !attached.has(doc.storedPath));
  if (fresh.length === 0) return;
  await tx.attachment.createMany({
    data: fresh.map((doc) => ({
      ...owner,
      fileName: doc.fileName,
      storedPath: doc.storedPath,
      mime: doc.mime,
      size: doc.size,
    })),
  });
}

/** Approve → write the reviewed facts into the live library. */
export async function publishIngestItem(
  actor: Actor,
  rawId: unknown,
  rawPayload: unknown,
  rawNote: unknown,
  rawResolution: unknown = { mode: "AUTO" },
) {
  assertReviewer(actor);
  const id = ingestIdSchema.parse(rawId);
  const payload = ingestPayloadSchema.parse(rawPayload);
  const reviewNote = ingestReviewNoteSchema.parse(rawNote);
  const resolution = publishResolutionSchema.parse(rawResolution);
  const item = await db.ingestItem.findFirst({
    where: { id, organizationId: actor.org, status: "PENDING" },
  });
  if (!item) throw new Error("Item not found or already reviewed.");
  const kind = ingestKindSchema.parse(item.kind);

  const updateTargetId =
    resolution.mode === "UPDATE" ? resolution.targetId : null;

  await db.$transaction(
    async (tx) => {
      // Publications of the same kind in one organization are serialized.
      // This closes the race where two reviewers approve equivalent pending
      // items before either library row is visible to the other.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${actor.org}:${kind}`}, 0))`;

      // Re-check inside the write transaction. Two reviewers cannot publish
      // the same queue item, and a failed library write leaves it pending.
      const pending = await tx.ingestItem.findFirst({
        where: { id, organizationId: actor.org, status: "PENDING" },
        select: { id: true },
      });
      if (!pending) throw new Error("Item not found or already reviewed.");

      // Nothing enters the library without the duplicate question being
      // answered. This authoritative check runs after the advisory lock.
      if (resolution.mode === "AUTO") {
        const duplicates = (
          await findDuplicates(actor, kind, payload, id)
        ).filter((duplicate) => duplicate.source === "LIBRARY");
        if (duplicates.length > 0) {
          throw new Error(
            `This matches ${duplicates.length === 1 ? "an existing record" : `${duplicates.length} existing records`} (${duplicates
              .map((duplicate) => duplicate.name)
              .join(", ")}). Choose whether to update it or skip this item.`,
          );
        }
      }

      let publishedId: string | null = null;

      if (item.kind === "MATERIAL") {
        const d = parseIngestDraft(kind, payload) as MaterialDraft;
        // Only an explicitly chosen target is updated; otherwise this is new.
        const existing = updateTargetId
          ? await tx.material.findFirst({
              where: { id: updateTargetId, organizationId: actor.org },
            })
          : null;
        if (updateTargetId && !existing)
          throw new Error("The material to update no longer exists.");
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
          ? await tx.material.update({
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
                properties: (existing.properties ??
                  {}) as Prisma.InputJsonValue,
                notes: existing.notes,
              }),
            })
          : await tx.material.create({
              data: { ...data, organizationId: actor.org },
            });
        publishedId = rec.id;
      } else if (item.kind === "EQUIPMENT") {
        const d = parseIngestDraft(kind, payload) as EquipmentDraft;
        // Match the process/location by name; both are required context for equipment.
        const process = d.processName
          ? await tx.process.findFirst({
              where: { organizationId: actor.org, name: d.processName },
            })
          : null;
        // Equipment must belong to a process — the reviewer picks a valid one.
        if (!process)
          throw new Error(
            "Pick an existing process for this equipment before publishing.",
          );
        let locationId: string | null = null;
        if (d.locationName?.trim()) {
          const loc = await tx.location.findFirst({
            where: { organizationId: actor.org, name: d.locationName.trim() },
          });
          locationId =
            loc?.id ??
            (
              await tx.location.create({
                data: {
                  organizationId: actor.org,
                  name: d.locationName.trim(),
                },
              })
            ).id;
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
          ? await tx.equipment.findFirst({
              where: { id: updateTargetId, organizationId: actor.org },
            })
          : null;
        if (updateTargetId && !existingEquip)
          throw new Error("The equipment to update no longer exists.");
        const rec = existingEquip
          ? await tx.equipment.update({
              where: { id: existingEquip.id },
              data: equipData,
            })
          : await tx.equipment.create({
              data: { ...equipData, organizationId: actor.org },
            });
        await attachDocuments(tx, { equipmentId: rec.id }, d.documents);
        publishedId = rec.id;
      } else if (item.kind === "FORMULA") {
        // Formulas are proprietary — publishing one needs recipe access, not just
        // staff.
        await assertStewardship(actor, "recipeAccess");
        const d = parseIngestDraft(kind, payload) as FormulaDraft;
        const name = d.name?.trim();
        if (!name) throw new Error("Formula name is required.");
        const components = (d.components ?? [])
          .filter((c) => c.material?.trim())
          .map((c) => ({
            material: c.material.trim(),
            amount: (c.amount ?? "").trim(),
            role: (c.role ?? "").trim(),
          }));
        if (components.length === 0)
          throw new Error("A formula needs at least one component.");
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
          ? await tx.recipe.findFirst({
              where: { id: updateTargetId, organizationId: actor.org },
            })
          : null;
        if (updateTargetId && !existing)
          throw new Error("The recipe to update no longer exists.");
        const rec = existing
          ? await tx.recipe.update({ where: { id: existing.id }, data })
          : await tx.recipe.create({
              data: {
                ...data,
                organizationId: actor.org,
                createdById: actor.uid,
              },
            });
        publishedId = rec.id;
      } else if (item.kind === "ENVIRONMENT") {
        const d = parseIngestDraft(kind, payload) as EnvironmentDraft;
        const conditions = (d.conditions ?? [])
          .filter((c) => c.name?.trim())
          .map((c) => ({
            name: c.name.trim(),
            unit: (c.unit ?? "").trim(),
            defaultValue: (c.defaultValue ?? "").trim(),
          }));
        const envData = {
          name: d.name.trim(),
          conditions: conditions as Prisma.InputJsonValue,
          notes: (d.notes ?? "").trim(),
        };
        const existing = updateTargetId
          ? await tx.labEnvironment.findFirst({
              where: { id: updateTargetId, organizationId: actor.org },
            })
          : null;
        if (updateTargetId && !existing)
          throw new Error("The environment to update no longer exists.");
        const rec = existing
          ? await tx.labEnvironment.update({
              where: { id: existing.id },
              // A draft that says nothing about conditions or notes must not
              // erase what the environment already records.
              data: mergeKeep(envData, {
                name: existing.name,
                conditions: (existing.conditions ??
                  []) as Prisma.InputJsonValue,
                notes: existing.notes,
              }),
            })
          : await tx.labEnvironment.create({
              data: { ...envData, organizationId: actor.org },
            });
        await attachDocuments(tx, { labEnvironmentId: rec.id }, d.documents);
        publishedId = rec.id;
      } else if (item.kind === "PRESET") {
        const d = parseIngestDraft(kind, payload) as PresetDraft;
        // A preset is a saved configuration OF a process, so the process must exist.
        const process = d.processName
          ? await tx.process.findFirst({
              where: { organizationId: actor.org, name: d.processName },
            })
          : null;
        if (!process)
          throw new Error(
            "Pick an existing process for this preset before publishing.",
          );
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
        const presetPayload = {
          materials: [],
          parameters,
        } as Prisma.InputJsonValue;
        const existing = updateTargetId
          ? await tx.preset.findFirst({
              where: { id: updateTargetId, organizationId: actor.org },
            })
          : null;
        if (updateTargetId && !existing)
          throw new Error("The preset to update no longer exists.");
        const rec = existing
          ? await tx.preset.update({
              where: { id: existing.id },
              data: {
                name: d.name.trim(),
                processId: process.id,
                payload: presetPayload,
              },
            })
          : await tx.preset.create({
              data: {
                organizationId: actor.org,
                kind: "STEP",
                processId: process.id,
                name: d.name.trim(),
                payload: presetPayload,
                createdById: actor.uid,
              },
            });
        publishedId = rec.id;
      } else {
        const draft = parseIngestDraft(kind, payload) as ExperimentDraft;
        publishedId = await publishExperiment(tx, actor, draft);
      }

      await tx.ingestItem.update({
        where: { id },
        data: {
          status: "PUBLISHED",
          payload: payload as Prisma.InputJsonValue,
          reviewNote,
          reviewedAt: new Date(),
          reviewedById: actor.uid,
          publishedId,
        },
      });
      await recordUserAudit(tx, {
        actor,
        action: "ingest.item.published",
        entityType: "IngestItem",
        entityId: id,
        changes: { kind, publishedId, resolution: resolution.mode },
      });
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: 120_000,
    },
  );
}

// ---- Historical experiments ----

/**
 * The operator who ran a historical batch, as a real (but inactive) account.
 *
 * The source folders carry only a name — "joey" — so each becomes an inactive
 * user that owns their imported work. When that person registers with their
 * real address an admin merges the two; until then nobody can sign in as them.
 */
async function operatorUser(
  tx: Prisma.TransactionClient,
  actor: Actor,
  operator: string,
) {
  const name = operator.trim();
  if (!name) throw new Error("The experiment needs an operator.");
  const existing = await tx.user.findFirst({
    where: { organizationId: actor.org, name },
  });
  if (existing) return existing;
  const org = await tx.organization.findUniqueOrThrow({
    where: { id: actor.org },
  });
  const last = await tx.user.findFirst({
    where: { organizationId: actor.org },
    orderBy: { userNumber: "desc" },
    select: { userNumber: true },
  });
  return tx.user.create({
    data: {
      organizationId: actor.org,
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
async function publishExperiment(
  tx: Prisma.TransactionClient,
  actor: Actor,
  d: ExperimentDraft,
): Promise<string> {
  if (!d.title?.trim()) throw new Error("The experiment needs a title.");
  const owner = await operatorUser(tx, actor, d.operator);

  // Resolve library references by name up front — a miss is left unlinked
  // rather than invented, and shows up in the review form as a warning.
  const processes = await tx.process.findMany({
    where: { organizationId: actor.org, archived: false },
    select: { id: true, name: true, kind: true, defaultLayer: true },
  });
  const procIndex = buildNameIndex(processes);
  const materials = await tx.material.findMany({
    where: { organizationId: actor.org, archived: false },
    select: { id: true, name: true },
  });
  const matIndex = buildNameIndex(materials);
  const recipes = await tx.recipe.findMany({
    where: { organizationId: actor.org, archived: false },
    select: { id: true, name: true },
  });
  const recipeIndex = buildNameIndex(recipes);

  const year = (d.date || "").slice(0, 4) || String(new Date().getFullYear());
  const org = await tx.organization.findUniqueOrThrow({
    where: { id: actor.org },
  });
  const seq = owner.nextExpSeq;
  const code = `${year}-${String(org.orgNumber).padStart(3, "0")}-${owner.userNumber}-${seq}`;

  await tx.user.update({
    where: { id: owner.id },
    data: { nextExpSeq: seq + 1 },
  });

  const exp = await tx.experiment.create({
    data: {
      organizationId: actor.org,
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
        recipeId: s.recipeName
          ? (matchName(s.recipeName, recipeIndex)?.id ?? null)
          : null,
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
        data: {
          stepId: step.id,
          materialId: mat.id,
          amount: "",
          position: mp++,
        },
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
      if (Object.keys(metrics).length === 0 && (s.files ?? []).length === 0)
        continue;
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
            mime: f.toLowerCase().endsWith(".csv")
              ? "text/csv"
              : "application/octet-stream",
            size: 0,
            characterizationResultId: res.id,
          },
        });
      }
    }
  }

  await recordUserAudit(tx, {
    actor,
    action: "experiment.imported",
    entityType: "Experiment",
    entityId: exp.id,
    metadata: { operator: d.operator, batchLabel: d.batchLabel },
  });
  return exp.id;
}

// ---- Duplicate detection ----
//
// Only genuinely new facts should enter the library. Before anything is
// published every staged item is checked against the live library AND against
// the rest of the queue, so a reviewer sees the collision and decides: update
// the existing record, skip the item, or (deliberately) create a second one.
