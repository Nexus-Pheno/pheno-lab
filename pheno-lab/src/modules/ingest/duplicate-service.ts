import "server-only";

import { db } from "@/infrastructure/db/client";
import type { Actor } from "@/modules/authorization/actor";
import { assertStaff } from "@/modules/authorization/policy";
import { recordUserAudit } from "@/modules/audit/writer";
import { findDuplicates } from "./duplicate-query";
import { publishIngestItem } from "./publish-service";
import {
  duplicateActionSchema,
  ingestIdSchema,
  ingestIdsSchema,
  ingestReviewNoteSchema,
} from "./schema";

function assertReviewer(actor: Actor): void {
  assertStaff(actor);
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
export async function publishIngestItems(
  actor: Actor,
  rawIds: unknown,
): Promise<BulkPublishResult[]> {
  assertReviewer(actor);
  const ids = ingestIdsSchema.parse(rawIds);
  const items = await db.ingestItem.findMany({
    where: { id: { in: ids }, organizationId: actor.org, status: "PENDING" },
  });

  // Materials first, so a formula's components resolve against them in the
  // library view straight after the run.
  const order: Record<string, number> = {
    MATERIAL: 0,
    EQUIPMENT: 1,
    FORMULA: 2,
    EXPERIMENT: 3,
  };
  items.sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9));

  const results: BulkPublishResult[] = [];
  for (const item of items) {
    const payload = (item.payload ?? {}) as Record<string, unknown>;
    try {
      const dups = (
        await findDuplicates(actor, item.kind, payload, item.id)
      ).filter((d) => d.source === "LIBRARY");
      if (dups.length > 0) {
        results.push({
          id: item.id,
          title: item.title,
          outcome: "HELD",
          message: dups.map((d) => d.name).join(", "),
        });
        continue;
      }
      await publishIngestItem(actor, item.id, payload, item.reviewNote);
      results.push({
        id: item.id,
        title: item.title,
        outcome: "PUBLISHED",
        message: "",
      });
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
  actor: Actor,
  rawIds: unknown,
  rawAction: unknown,
): Promise<BulkPublishResult[]> {
  assertReviewer(actor);
  const ids = ingestIdsSchema.parse(rawIds);
  const action = duplicateActionSchema.parse(rawAction);
  const items = await db.ingestItem.findMany({
    where: { id: { in: ids }, organizationId: actor.org, status: "PENDING" },
  });

  const results: BulkPublishResult[] = [];
  for (const item of items) {
    const payload = (item.payload ?? {}) as Record<string, unknown>;
    try {
      if (action === "DELETE") {
        await deleteIngestItem(actor, item.id);
        results.push({
          id: item.id,
          title: item.title,
          outcome: "PUBLISHED",
          message: "",
        });
        continue;
      }

      const dups = (
        await findDuplicates(actor, item.kind, payload, item.id)
      ).filter((d) => d.source === "LIBRARY");

      if (action === "SKIP") {
        await markIngestDuplicate(actor, item.id, item.reviewNote, dups[0]?.id);
        results.push({
          id: item.id,
          title: item.title,
          outcome: "PUBLISHED",
          message: "",
        });
        continue;
      }

      // REPLACE: overwrite the single matched record. An ambiguous match is
      // left for a human — we never guess which of several records to edit.
      if (dups.length === 0) {
        await publishIngestItem(actor, item.id, payload, item.reviewNote);
      } else if (dups.length === 1) {
        await publishIngestItem(actor, item.id, payload, item.reviewNote, {
          mode: "UPDATE",
          targetId: dups[0].id,
        });
      } else {
        results.push({
          id: item.id,
          title: item.title,
          outcome: "HELD",
          message: dups.map((d) => d.name).join(", "),
        });
        continue;
      }
      results.push({
        id: item.id,
        title: item.title,
        outcome: "PUBLISHED",
        message: "",
      });
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
export async function markIngestDuplicate(
  actor: Actor,
  rawId: unknown,
  rawNote: unknown,
  rawTargetId?: unknown,
) {
  assertReviewer(actor);
  const id = ingestIdSchema.parse(rawId);
  const reviewNote = ingestReviewNoteSchema.parse(rawNote);
  const targetId = rawTargetId ? ingestIdSchema.parse(rawTargetId) : undefined;
  await db.$transaction(async (tx) => {
    const result = await tx.ingestItem.updateMany({
      where: { id, organizationId: actor.org, status: "PENDING" },
      data: {
        status: "DUPLICATE",
        reviewNote,
        reviewedAt: new Date(),
        reviewedById: actor.uid,
        publishedId: targetId ?? null,
      },
    });
    if (result.count !== 1) throw new Error("Pending ingest item not found.");
    await recordUserAudit(tx, {
      actor,
      action: "ingest.item.duplicate",
      entityType: "IngestItem",
      entityId: id,
      changes: { targetId, reviewNote },
    });
  });
}

export async function deleteIngestItem(actor: Actor, rawId: unknown) {
  assertReviewer(actor);
  const id = ingestIdSchema.parse(rawId);
  await db.$transaction(async (tx) => {
    const result = await tx.ingestItem.deleteMany({
      where: { id, organizationId: actor.org },
    });
    if (result.count !== 1) throw new Error("Ingest item not found.");
    await recordUserAudit(tx, {
      actor,
      action: "ingest.item.deleted",
      entityType: "IngestItem",
      entityId: id,
    });
  });
}
