"use server";

import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { revalidatePath } from "next/cache";

// Export control and audit.
//
// Everyone can SEE the data; taking it out of the system is what is gated.
// An administrator exports directly, and the export is still written to the
// log — the log has no exceptions, otherwise it cannot answer "who took data
// out". Managers and technicians raise a request that an administrator
// approves, after which they may download once.
//
// This is an accountability control, not a containment one: the rows are
// already rendered in the browser for anyone allowed to view them, so someone
// determined could copy them by hand. What this guarantees is that a real
// export leaves a record with a name and a timestamp against it.

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

/**
 * Ask to export. Administrators are cleared immediately (and logged);
 * everyone else gets a request an administrator must approve.
 */
export async function requestExport(input: {
  scope: string;
  detail: string;
  rowCount: number;
  reason: string;
}): Promise<ExportDecision> {
  const session = await requireSession();
  const base = {
    organizationId: session.org,
    requestedById: session.uid,
    scope: input.scope.slice(0, 120),
    detail: input.detail.slice(0, 500),
    rowCount: Math.max(0, Math.floor(input.rowCount)),
    reason: input.reason.slice(0, 500),
  };

  if (session.role === "ADMIN") {
    const r = await db.exportRequest.create({
      data: {
        ...base,
        status: "APPROVED",
        decidedById: session.uid,
        decidedAt: new Date(),
        decisionNote: "Administrator export — auto-approved",
        downloadedAt: new Date(),
        downloadCount: 1,
      },
    });
    revalidatePath("/exports");
    return { outcome: "ALLOWED", requestId: r.id };
  }

  // An approval already granted and not yet used lets them straight through.
  const approved = await db.exportRequest.findFirst({
    where: {
      organizationId: session.org,
      requestedById: session.uid,
      scope: base.scope,
      status: "APPROVED",
      downloadCount: 0,
    },
    orderBy: { decidedAt: "desc" },
  });
  if (approved) {
    await db.exportRequest.update({
      where: { id: approved.id },
      data: { downloadedAt: new Date(), downloadCount: { increment: 1 }, rowCount: base.rowCount },
    });
    revalidatePath("/exports");
    return { outcome: "ALLOWED", requestId: approved.id };
  }

  const pending = await db.exportRequest.findFirst({
    where: {
      organizationId: session.org,
      requestedById: session.uid,
      scope: base.scope,
      status: "PENDING",
    },
  });
  if (pending) return { outcome: "PENDING", requestId: pending.id };

  const r = await db.exportRequest.create({ data: { ...base, status: "PENDING" } });
  revalidatePath("/exports");
  return { outcome: "REQUESTED", requestId: r.id };
}

/** Everything in the audit trail. Administrators see all; others see their own. */
export async function listExportRequests(): Promise<ExportRow[]> {
  const session = await requireSession();
  const rows = await db.exportRequest.findMany({
    where: {
      organizationId: session.org,
      ...(session.role === "ADMIN" ? {} : { requestedById: session.uid }),
    },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 500,
    include: {
      requestedBy: { select: { name: true } },
      decidedBy: { select: { name: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    scope: r.scope,
    detail: r.detail,
    rowCount: r.rowCount,
    reason: r.reason,
    status: r.status,
    requestedBy: r.requestedBy?.name ?? "",
    decidedBy: r.decidedBy?.name ?? null,
    decisionNote: r.decisionNote,
    createdAt: r.createdAt.toISOString().slice(0, 16).replace("T", " "),
    decidedAt: r.decidedAt ? r.decidedAt.toISOString().slice(0, 16).replace("T", " ") : null,
    downloadedAt: r.downloadedAt ? r.downloadedAt.toISOString().slice(0, 16).replace("T", " ") : null,
    downloadCount: r.downloadCount,
  }));
}

export async function decideExportRequest(id: string, approve: boolean, note: string) {
  const session = await requireSession();
  if (session.role !== "ADMIN") throw new Error("Only an administrator can decide export requests.");
  await db.exportRequest.updateMany({
    where: { id, organizationId: session.org, status: "PENDING" },
    data: {
      status: approve ? "APPROVED" : "DENIED",
      decidedById: session.uid,
      decidedAt: new Date(),
      decisionNote: note.slice(0, 500),
    },
  });
  revalidatePath("/exports");
}

/** How many requests are waiting — for the admin's badge. */
export async function pendingExportCount(): Promise<number> {
  const session = await requireSession();
  if (session.role !== "ADMIN") return 0;
  return db.exportRequest.count({ where: { organizationId: session.org, status: "PENDING" } });
}

/**
 * Build the CSV for the current data-table search, server-side.
 *
 * The browser only ever holds one page of rows now, so the file cannot be
 * assembled client-side. Capped at 300 experiments per download.
 */
export async function buildDataCsv(query: string): Promise<{ csv: string; rows: number; columns: number }> {
  const session = await requireSession();
  const { canViewWhere } = await import("@/lib/actions/experiments");
  const { loadDataForExport } = await import("@/lib/data-rows");
  const data = await loadDataForExport(await canViewWhere(session), query);
  const esc = (v: string) => `"${(v ?? "").replaceAll('"', '""')}"`;
  const csv = [
    data.columns.map(esc).join(","),
    ...data.rows.map((r) => data.columns.map((c) => esc(r[c] ?? "")).join(",")),
  ].join("\n");
  return { csv, rows: data.rows.length, columns: data.columns.length };
}
