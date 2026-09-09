import "server-only";
import { z } from "zod";

import { db } from "@/infrastructure/db/client";
import type { Actor } from "@/modules/authorization/actor";
import { AuthorizationError, isStaff } from "@/modules/authorization/policy";
import { recordUserAudit } from "@/modules/audit/writer";

// 课题组 (research projects): the manager-curated list every real experiment
// picks from before it may go to the lab. Projects group and filter — they are
// deliberately NOT an analysis boundary (多实验组关联方案 caveat: insight often
// lives across projects, e.g. a solvent tried under one 课题组 helping another).

const projectNameSchema = z.string().trim().min(1).max(200);
const projectIdSchema = z.string().min(1).max(128);

export type ProjectRow = {
  id: string;
  name: string;
  active: boolean;
  experimentCount: number;
};

function assertStaff(actor: Actor): void {
  if (!isStaff(actor))
    throw new AuthorizationError("Only managers curate the project list.");
}

/** Everyone reads the list (pickers, filters). Staff also see inactive rows. */
export async function listProjects(
  actor: Actor,
  opts: { includeInactive?: boolean } = {},
): Promise<ProjectRow[]> {
  const includeInactive = Boolean(opts.includeInactive) && isStaff(actor);
  const rows = await db.project.findMany({
    where: {
      organizationId: actor.org,
      ...(includeInactive ? {} : { active: true }),
    },
    orderBy: [{ active: "desc" }, { name: "asc" }],
    include: { _count: { select: { experiments: true } } },
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    active: row.active,
    experimentCount: row._count.experiments,
  }));
}

/**
 * Create (or revive) a project. Quick-create from the experiment settings
 * picker reuses an existing row of the same name instead of failing, so two
 * managers typing the same 课题组 converge on one entry.
 */
export async function createProject(
  actor: Actor,
  raw: unknown,
): Promise<{ id: string; name: string }> {
  assertStaff(actor);
  const name = projectNameSchema.parse(raw);
  return db.$transaction(async (tx) => {
    const existing = await tx.project.findUnique({
      where: { organizationId_name: { organizationId: actor.org, name } },
    });
    if (existing) {
      if (!existing.active)
        await tx.project.update({
          where: { id: existing.id },
          data: { active: true },
        });
      return { id: existing.id, name: existing.name };
    }
    const created = await tx.project.create({
      data: { organizationId: actor.org, name },
    });
    await recordUserAudit(tx, {
      actor,
      action: "project.create",
      entityType: "Project",
      entityId: created.id,
      changes: { name },
    });
    return { id: created.id, name: created.name };
  });
}

export async function renameProject(actor: Actor, raw: unknown): Promise<void> {
  assertStaff(actor);
  const input = z
    .object({ id: projectIdSchema, name: projectNameSchema })
    .parse(raw);
  await db.$transaction(async (tx) => {
    const result = await tx.project.updateMany({
      where: { id: input.id, organizationId: actor.org },
      data: { name: input.name },
    });
    if (result.count !== 1) throw new Error("Project not found.");
    await recordUserAudit(tx, {
      actor,
      action: "project.rename",
      entityType: "Project",
      entityId: input.id,
      changes: { name: input.name },
    });
  });
}

/** Deactivate hides a project from pickers; linked experiments keep it. */
export async function setProjectActive(
  actor: Actor,
  raw: unknown,
): Promise<void> {
  assertStaff(actor);
  const input = z
    .object({ id: projectIdSchema, active: z.boolean() })
    .parse(raw);
  await db.$transaction(async (tx) => {
    const result = await tx.project.updateMany({
      where: { id: input.id, organizationId: actor.org },
      data: { active: input.active },
    });
    if (result.count !== 1) throw new Error("Project not found.");
    await recordUserAudit(tx, {
      actor,
      action: input.active ? "project.activate" : "project.deactivate",
      entityType: "Project",
      entityId: input.id,
    });
  });
}
