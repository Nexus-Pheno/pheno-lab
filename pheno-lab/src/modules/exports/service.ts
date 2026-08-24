import "server-only";

import { db } from "@/infrastructure/db/client";
import { loadDataForExport } from "@/modules/data/query";
import type { Actor } from "@/modules/authorization/actor";
import { assertAdmin } from "@/modules/authorization/policy";
import { experimentVisibilityScope } from "@/modules/authorization/scope";
import { recordUserAudit } from "@/modules/audit/writer";
import {
  exportDecisionSchema,
  exportRequestSchema,
  exportSearchSchema,
} from "./schema";

export type ExportDecision =
  | { outcome: "ALLOWED"; requestId: string }
  | { outcome: "REQUESTED"; requestId: string }
  | { outcome: "PENDING"; requestId: string }
  | { outcome: "DENIED"; requestId: string; note: string };

export type ExportRow = {
  id: string;
  scope: string;
  detail: string;
  rowCount: number;
  reason: string;
  status: string;
  requestedBy: string;
  decidedBy: string | null;
  decisionNote: string;
  createdAt: string;
  decidedAt: string | null;
  downloadedAt: string | null;
  downloadCount: number;
};

export async function requestExport(
  actor: Actor,
  raw: unknown,
): Promise<ExportDecision> {
  const input = exportRequestSchema.parse(raw);
  return db.$transaction(async (tx) => {
    const base = {
      organizationId: actor.org,
      requestedById: actor.uid,
      scope: input.scope,
      detail: input.detail,
      rowCount: Math.floor(input.rowCount),
      reason: input.reason,
    };

    if (actor.role === "ADMIN") {
      const row = await tx.exportRequest.create({
        data: {
          ...base,
          status: "APPROVED",
          decidedById: actor.uid,
          decidedAt: new Date(),
          decisionNote: "Administrator export — auto-approved",
          downloadedAt: new Date(),
          downloadCount: 1,
        },
      });
      await recordUserAudit(tx, {
        actor,
        action: "export.downloaded",
        entityType: "ExportRequest",
        entityId: row.id,
        metadata: { scope: row.scope, rowCount: row.rowCount },
      });
      return { outcome: "ALLOWED", requestId: row.id };
    }

    const approved = await tx.exportRequest.findFirst({
      where: {
        organizationId: actor.org,
        requestedById: actor.uid,
        scope: base.scope,
        status: "APPROVED",
        downloadCount: 0,
      },
      orderBy: { decidedAt: "desc" },
    });
    if (approved) {
      await tx.exportRequest.update({
        where: { id: approved.id },
        data: {
          downloadedAt: new Date(),
          downloadCount: { increment: 1 },
          rowCount: base.rowCount,
        },
      });
      await recordUserAudit(tx, {
        actor,
        action: "export.downloaded",
        entityType: "ExportRequest",
        entityId: approved.id,
        metadata: { scope: base.scope, rowCount: base.rowCount },
      });
      return { outcome: "ALLOWED", requestId: approved.id };
    }

    const pending = await tx.exportRequest.findFirst({
      where: {
        organizationId: actor.org,
        requestedById: actor.uid,
        scope: base.scope,
        status: "PENDING",
      },
    });
    if (pending) return { outcome: "PENDING", requestId: pending.id };

    const row = await tx.exportRequest.create({
      data: { ...base, status: "PENDING" },
    });
    await recordUserAudit(tx, {
      actor,
      action: "export.requested",
      entityType: "ExportRequest",
      entityId: row.id,
      metadata: { scope: row.scope, rowCount: row.rowCount },
    });
    return { outcome: "REQUESTED", requestId: row.id };
  });
}

export async function listExportRequests(actor: Actor): Promise<ExportRow[]> {
  const rows = await db.exportRequest.findMany({
    where: {
      organizationId: actor.org,
      ...(actor.role === "ADMIN" ? {} : { requestedById: actor.uid }),
    },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 500,
    include: {
      requestedBy: { select: { name: true } },
      decidedBy: { select: { name: true } },
    },
  });
  const formatDate = (value: Date | null) =>
    value?.toISOString().slice(0, 16).replace("T", " ") ?? null;
  return rows.map((row) => ({
    id: row.id,
    scope: row.scope,
    detail: row.detail,
    rowCount: row.rowCount,
    reason: row.reason,
    status: row.status,
    requestedBy: row.requestedBy?.name ?? "",
    decidedBy: row.decidedBy?.name ?? null,
    decisionNote: row.decisionNote,
    createdAt: formatDate(row.createdAt)!,
    decidedAt: formatDate(row.decidedAt),
    downloadedAt: formatDate(row.downloadedAt),
    downloadCount: row.downloadCount,
  }));
}

export async function decideExportRequest(actor: Actor, raw: unknown) {
  assertAdmin(actor);
  const input = exportDecisionSchema.parse(raw);
  await db.$transaction(async (tx) => {
    const result = await tx.exportRequest.updateMany({
      where: {
        id: input.id,
        organizationId: actor.org,
        status: "PENDING",
      },
      data: {
        status: input.approve ? "APPROVED" : "DENIED",
        decidedById: actor.uid,
        decidedAt: new Date(),
        decisionNote: input.note,
      },
    });
    if (result.count !== 1)
      throw new Error("Pending export request not found.");
    await recordUserAudit(tx, {
      actor,
      action: input.approve ? "export.approved" : "export.denied",
      entityType: "ExportRequest",
      entityId: input.id,
      changes: { note: input.note },
    });
  });
}

export async function pendingExportCount(actor: Actor): Promise<number> {
  if (actor.role !== "ADMIN") return 0;
  return db.exportRequest.count({
    where: { organizationId: actor.org, status: "PENDING" },
  });
}

export async function buildDataCsv(actor: Actor, rawQuery: unknown) {
  const query = exportSearchSchema.parse(rawQuery);
  const data = await loadDataForExport(experimentVisibilityScope(actor), query);
  const escape = (value: string) => `"${(value ?? "").replaceAll('"', '""')}"`;
  const csv = [
    data.columns.map(escape).join(","),
    ...data.rows.map((row) =>
      data.columns.map((column) => escape(row[column] ?? "")).join(","),
    ),
  ].join("\n");
  return { csv, rows: data.rows.length, columns: data.columns.length };
}
