import "server-only";
import { createHash } from "node:crypto";
import type { Preset, Prisma, PersonalPreset } from "@prisma/client";
import { db } from "@/infrastructure/db/client";
import type { Actor } from "@/modules/authorization/actor";
import { assertFullAccess } from "@/modules/authorization/policy";
import { experimentIdSchema } from "./schema";
import {
  parsePresetRef,
  personalPresetRef,
  PresetOperationError,
} from "./preset-policy";

export async function freshPresetActor(
  actor: Actor,
  client: Prisma.TransactionClient = db,
) {
  const user = await client.user.findFirst({
    where: {
      id: actor.uid,
      organizationId: actor.org,
      active: true,
      pendingApproval: false,
    },
    select: {
      role: true,
      testingOnly: true,
      mustChangePassword: true,
      name: true,
    },
  });
  if (!user) throw new PresetOperationError("forbidden");
  const fresh = { ...actor, ...user };
  assertFullAccess(fresh);
  return fresh;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export const presetSnapshot = (
  p: Pick<Preset, "name" | "kind" | "processId" | "payload">,
) => ({
  name: p.name,
  kind: p.kind,
  processId: p.processId,
  payload: p.payload,
});
export const presetRevision = (
  p: Pick<Preset, "name" | "kind" | "processId" | "payload">,
) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(presetSnapshot(p))))
    .digest("hex");
export const usablePersonalPreset = (p: PersonalPreset) => ({
  id: personalPresetRef(p.id),
  organizationId: p.organizationId,
  kind: p.kind,
  processId: p.processId,
  name: p.name,
  payload: p.payload,
  usageCount: p.usageCount,
  createdById: p.ownerId,
  createdAt: p.createdAt,
  scope: "PERSONAL" as const,
});

export async function assertUsablePreset(
  tx: Prisma.TransactionClient,
  actor: Actor,
  ref: string,
  processId: string,
  kind: Preset["kind"],
) {
  const fresh = await freshPresetActor(actor, tx);
  const parsed = parsePresetRef(experimentIdSchema.parse(ref));
  const found = parsed.personal
    ? await tx.personalPreset.findFirst({
        where: {
          id: parsed.id,
          organizationId: fresh.org,
          ownerId: fresh.uid,
          processId,
          kind,
        },
      })
    : await tx.preset.findFirst({
        where: { id: parsed.id, organizationId: fresh.org, processId, kind },
      });
  if (!found) throw new PresetOperationError("not_found");
  if (parsed.personal)
    await tx.personalPreset.update({
      where: { id: found.id },
      data: { usageCount: { increment: 1 } },
    });
  else
    await tx.preset.update({
      where: { id: found.id },
      data: { usageCount: { increment: 1 } },
    });
}
