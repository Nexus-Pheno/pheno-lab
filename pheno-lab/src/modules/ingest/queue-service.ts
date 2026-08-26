import "server-only";

import { Prisma } from "@prisma/client";
import { db } from "@/infrastructure/db/client";
import type { MaterialCategory, RecipeComponent } from "@/lib/materials-meta";
import type { Actor } from "@/modules/authorization/actor";
import { assertStaff } from "@/modules/authorization/policy";
import { recordUserAudit } from "@/modules/audit/writer";
import {
  ingestIdSchema,
  ingestPayloadSchema,
  ingestReviewNoteSchema,
  stageIngestSchema,
} from "./schema";

export type IngestKind =
  | "EQUIPMENT"
  | "MATERIAL"
  | "EXPERIMENT"
  | "FORMULA"
  | "ENVIRONMENT"
  | "PRESET";

export type EquipmentDraft = {
  name: string;
  make: string;
  model: string;
  assetTag: string;
  processName: string; // matched to a Process by name on publish
  locationName: string;
  parameters: { name: string; unit: string; defaultValue: string }[];
  // Original vendor spec sheets, already uploaded to object storage. Publishing
  // attaches them to the equipment record.
  documents: {
    fileName: string;
    storedPath: string;
    mime: string;
    size: number;
  }[];
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
  /** Manuals for the enclosure itself, already uploaded to object storage. */
  documents: {
    fileName: string;
    storedPath: string;
    mime: string;
    size: number;
  }[];
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

function assertReviewer(actor: Actor): void {
  assertStaff(actor);
}

export async function listIngestItems(actor: Actor) {
  return db.ingestItem.findMany({
    where: { organizationId: actor.org },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    include: { reviewedBy: { select: { name: true } } },
  });
}

/** Stage extracted facts for review (used by the agent intake script). */
export async function stageIngestItem(
  actor: Actor,
  raw: {
    kind: IngestKind;
    title: string;
    sourceFile?: string;
    confidence?: string;
    payload: Record<string, unknown>;
  },
) {
  assertReviewer(actor);
  const data = stageIngestSchema.parse(raw);
  return db.$transaction(async (tx) => {
    const row = await tx.ingestItem.create({
      data: {
        organizationId: actor.org,
        kind: data.kind,
        title: data.title,
        sourceFile: data.sourceFile ?? "",
        confidence: data.confidence ?? "",
        payload: data.payload as Prisma.InputJsonValue,
      },
    });
    await recordUserAudit(tx, {
      actor,
      action: "ingest.item.staged",
      entityType: "IngestItem",
      entityId: row.id,
      metadata: { kind: row.kind, sourceFile: row.sourceFile },
    });
    return row;
  });
}

/**
 * One item's full payload, fetched only when the reviewer opens it.
 *
 * The queue list deliberately does NOT carry payloads: a single imported
 * experiment holds hundreds of samples, so sending every payload to the
 * browser made the page unusable once real data arrived.
 */
export async function getIngestPayload(
  actor: Actor,
  rawId: unknown,
): Promise<Record<string, unknown>> {
  const id = ingestIdSchema.parse(rawId);
  const item = await db.ingestItem.findFirst({
    where: { id, organizationId: actor.org },
    select: { payload: true },
  });
  return (item?.payload ?? {}) as Record<string, unknown>;
}

/** Save reviewer edits without publishing. */
export async function updateIngestPayload(
  actor: Actor,
  rawId: unknown,
  rawPayload: unknown,
  rawNote: unknown,
) {
  assertReviewer(actor);
  const id = ingestIdSchema.parse(rawId);
  const payload = ingestPayloadSchema.parse(rawPayload);
  const reviewNote = ingestReviewNoteSchema.parse(rawNote);
  await db.$transaction(async (tx) => {
    const result = await tx.ingestItem.updateMany({
      where: { id, organizationId: actor.org, status: "PENDING" },
      data: { payload: payload as Prisma.InputJsonValue, reviewNote },
    });
    if (result.count !== 1) throw new Error("Pending ingest item not found.");
    await recordUserAudit(tx, {
      actor,
      action: "ingest.item.edited",
      entityType: "IngestItem",
      entityId: id,
    });
  });
}

export async function rejectIngestItem(
  actor: Actor,
  rawId: unknown,
  rawNote: unknown,
) {
  assertReviewer(actor);
  const id = ingestIdSchema.parse(rawId);
  const reviewNote = ingestReviewNoteSchema.parse(rawNote);
  await db.$transaction(async (tx) => {
    const result = await tx.ingestItem.updateMany({
      where: { id, organizationId: actor.org, status: "PENDING" },
      data: {
        status: "REJECTED",
        reviewNote,
        reviewedAt: new Date(),
        reviewedById: actor.uid,
      },
    });
    if (result.count !== 1) throw new Error("Pending ingest item not found.");
    await recordUserAudit(tx, {
      actor,
      action: "ingest.item.rejected",
      entityType: "IngestItem",
      entityId: id,
      changes: { reviewNote },
    });
  });
}
