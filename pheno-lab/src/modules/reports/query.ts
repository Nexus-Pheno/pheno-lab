import "server-only";

import { db } from "@/infrastructure/db/client";
import type { Actor } from "@/modules/authorization/actor";
import {
  assertFullAccess,
  AuthorizationError,
} from "@/modules/authorization/policy";
import { reportIdSchema, reportListSchema } from "./schema";

export const reportMetadataSelect = {
  id: true,
  titleEn: true,
  titleZh: true,
  generatedAt: true,
} as const;

async function freshReportUser(actor: Actor) {
  assertFullAccess(actor);
  const user = await db.user.findFirst({
    where: {
      id: actor.uid,
      organizationId: actor.org,
      active: true,
      pendingApproval: false,
      testingOnly: false,
      mustChangePassword: false,
      organization: { status: "ACTIVE" },
    },
    select: { role: true, reportAccess: true },
  });
  if (!user) throw new AuthorizationError();
  return user;
}

export async function canOpenReports(actor: Actor): Promise<boolean> {
  const user = await freshReportUser(actor);
  return (
    user.reportAccess && (user.role === "ADMIN" || user.role === "MANAGER")
  );
}

export async function requireReportAccess(actor: Actor) {
  if (!(await canOpenReports(actor)))
    throw new AuthorizationError("Report access is restricted.");
}

export async function listLabReports(actor: Actor, raw: unknown) {
  const { page } = reportListSchema.parse(raw);
  const canOpen = await canOpenReports(actor);
  const where = { organizationId: actor.org };
  const [total, rows] = await Promise.all([
    db.labReport.count({ where }),
    db.labReport.findMany({
      where,
      select: reportMetadataSelect,
      orderBy: [{ generatedAt: "desc" }, { id: "desc" }],
      take: 20,
      skip: (page - 1) * 20,
    }),
  ]);
  return {
    total,
    page,
    canOpen,
    rows: rows.map((row) => ({
      ...row,
      generatedAt: row.generatedAt.toISOString(),
    })),
  };
}

export async function getLabReportMetadata(actor: Actor, rawId: unknown) {
  const id = reportIdSchema.parse(rawId);
  await requireReportAccess(actor);
  const row = await db.labReport.findFirst({
    where: { id, organizationId: actor.org },
    select: reportMetadataSelect,
  });
  return row ? { ...row, generatedAt: row.generatedAt.toISOString() } : null;
}
