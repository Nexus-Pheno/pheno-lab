import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { db } from "@/infrastructure/db/client";
import type { Actor } from "@/modules/authorization/actor";
import {
  AuthorizationError,
  assertAdmin,
} from "@/modules/authorization/policy";
import { requireChemicalAccess } from "@/modules/chemicals/query";
import { recordUserAudit } from "@/modules/audit/writer";

const eligible = {
  active: true,
  pendingApproval: false,
  testingOnly: false,
  mustChangePassword: false,
  role: "ADMIN",
  organization: { status: "ACTIVE" },
} as const;
const keyInfo = {
  id: true,
  label: true,
  expiresAt: true,
  revokedAt: true,
  reports: true,
  chemistry: true,
  filmStudies: true,
} as const;
const keyInput = z
  .object({
    label: z.string().trim().min(1).max(80),
    days: z.union([z.literal(1), z.literal(7), z.literal(30)]),
    reports: z.boolean(),
    chemistry: z.boolean(),
    filmStudies: z.boolean().default(false),
  })
  .strict();
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function personalAdmin(actor: Actor & { device?: unknown }) {
  assertAdmin(actor);
  if (actor.device) throw new AuthorizationError();
}
export async function readerSettings(actor: Actor) {
  personalAdmin(actor);
  const user = await db.user.findFirst({
    where: { ...eligible, id: actor.uid, organizationId: actor.org },
    select: {
      sessionVersion: true,
      reportAccess: true,
      chemicalAccess: true,
      filmStudyAgentAccess: true,
    },
  });
  if (!user) throw new AuthorizationError();
  const keys = await db.researchReaderKey.findMany({
    where: {
      userId: actor.uid,
      organizationId: actor.org,
      sessionVersion: user.sessionVersion,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    select: keyInfo,
    orderBy: { createdAt: "desc" },
  });
  return {
    reportAccess: user.reportAccess,
    chemicalAccess: user.chemicalAccess,
    filmStudyAgentAccess: user.filmStudyAgentAccess,
    keys,
  };
}
export async function issueReaderKey(actor: Actor, raw: unknown) {
  personalAdmin(actor);
  const input = keyInput.parse(raw);
  const secret = "phr_" + randomBytes(32).toString("base64url");
  return db.$transaction(async (tx) => {
    const owner = await tx.user.findFirst({
      where: { ...eligible, id: actor.uid, organizationId: actor.org },
      select: {
        sessionVersion: true,
        reportAccess: true,
        filmStudyAgentAccess: true,
      },
    });
    if (
      !owner ||
      (input.reports && !owner.reportAccess) ||
      (input.filmStudies && !owner.filmStudyAgentAccess)
    )
      throw new AuthorizationError();
    if (input.chemistry) await requireChemicalAccess(actor, tx);
    const key = await tx.researchReaderKey.create({
      data: {
        userId: actor.uid,
        organizationId: actor.org,
        sessionVersion: owner.sessionVersion,
        label: input.label,
        reports: input.reports,
        chemistry: input.chemistry,
        filmStudies: input.filmStudies,
        digest: digest(secret),
        expiresAt: new Date(Date.now() + input.days * 86400000),
      },
      select: keyInfo,
    });
    await recordUserAudit(tx, {
      actor,
      action: "research.reader.issued",
      entityType: "ResearchReaderKey",
      entityId: key.id,
      metadata: {
        reports: input.reports,
        chemistry: input.chemistry,
        filmStudies: input.filmStudies,
        days: input.days,
      },
    });
    return { secret, id: key.id };
  });
}
export async function revokeReaderKey(actor: Actor, id: string) {
  personalAdmin(actor);
  await db.$transaction(async (tx) => {
    const revoked = await tx.researchReaderKey.updateMany({
      where: {
        id,
        userId: actor.uid,
        organizationId: actor.org,
        user: eligible,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
    if (revoked.count)
      await recordUserAudit(tx, {
        actor,
        action: "research.reader.revoked",
        entityType: "ResearchReaderKey",
        entityId: id,
      });
  });
}
export async function authenticateReader(header: string | null) {
  if (!header || !/^Bearer phr_[a-zA-Z0-9_-]{43}$/.test(header)) return null;
  const key = await db.researchReaderKey.findFirst({
    where: {
      digest: digest(header.slice(7)),
      expiresAt: { gt: new Date() },
      revokedAt: null,
      user: eligible,
    },
    select: {
      id: true,
      organizationId: true,
      sessionVersion: true,
      reports: true,
      chemistry: true,
      filmStudies: true,
      user: {
        select: {
          id: true,
          organizationId: true,
          sessionVersion: true,
          role: true,
          reportAccess: true,
          chemicalAccess: true,
          filmStudyAgentAccess: true,
        },
      },
    },
  });
  if (
    !key ||
    key.user.organizationId !== key.organizationId ||
    key.sessionVersion !== key.user.sessionVersion
  )
    return null;
  return {
    id: key.id,
    actor: { uid: key.user.id, org: key.organizationId, role: key.user.role },
    reports: key.reports && key.user.reportAccess,
    chemistry: key.chemistry && key.user.chemicalAccess,
    filmStudies: key.filmStudies && key.user.filmStudyAgentAccess,
  };
}
export type Reader = NonNullable<
  Awaited<ReturnType<typeof authenticateReader>>
>;
