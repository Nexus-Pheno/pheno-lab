import "server-only";

import { db } from "@/infrastructure/db/client";
import { experimentInclude } from "@/lib/types";
import type { Actor } from "@/modules/authorization/actor";
import { experimentVisibilityScope } from "@/modules/authorization/scope";
import { hasStewardship } from "@/modules/stewardship/service";
import { experimentIdSchema } from "./schema";

export async function listDashboardExperiments(actor: Actor) {
  const rows = await db.experiment.findMany({
    where: experimentVisibilityScope(actor),
    orderBy: { updatedAt: "desc" },
    include: {
      createdBy: { select: { name: true } },
      members: { include: { user: { select: { name: true } } } },
      labels: { include: { label: true } },
      _count: {
        select: { samples: true, steps: true, characterizations: true },
      },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    title: row.title,
    status: row.status,
    createdBy: row.createdBy.name,
    members: row.members.map((member) => member.user.name),
    labels: row.labels.map((label) => label.label.name),
    campaign: row.campaign,
    samples: row._count.samples,
    steps: row._count.steps,
    characterizations: row._count.characterizations,
    updatedAt: row.updatedAt.toISOString().slice(0, 10),
  }));
}

export async function listPortalExperiments(actor: Actor) {
  return db.experiment.findMany({
    where: experimentVisibilityScope(actor),
    orderBy: { updatedAt: "desc" },
    include: {
      _count: { select: { samples: true, steps: true } },
      runs: {
        where: { status: { not: "CANCELLED" } },
        include: { _count: { select: { executions: true } } },
        orderBy: { runNo: "desc" },
      },
    },
  });
}

export async function getExperimentDesignerData(actor: Actor, rawId: unknown) {
  const id = experimentIdSchema.parse(rawId);
  const [
    experiment,
    processes,
    equipment,
    materials,
    environments,
    presets,
    orgUsers,
    recipes,
    canManageMaterials,
    layers,
    categoryLayers,
  ] = await Promise.all([
    db.experiment.findFirst({
      where: { AND: [{ id }, experimentVisibilityScope(actor, true)] },
      include: experimentInclude,
    }),
    db.process.findMany({
      where: { organizationId: actor.org, archived: false },
      orderBy: { position: "asc" },
    }),
    db.equipment.findMany({
      where: { organizationId: actor.org, archived: false },
      orderBy: { name: "asc" },
    }),
    db.material.findMany({
      where: { organizationId: actor.org, archived: false },
      orderBy: { name: "asc" },
    }),
    db.labEnvironment.findMany({
      where: { organizationId: actor.org, archived: false },
      orderBy: { name: "asc" },
    }),
    db.preset.findMany({
      where: { organizationId: actor.org },
      orderBy: { usageCount: "desc" },
    }),
    db.user.findMany({
      where: { organizationId: actor.org, active: true },
      select: { id: true, name: true, email: true, role: true },
      orderBy: { name: "asc" },
    }),
    db.recipe.findMany({
      where: { organizationId: actor.org, archived: false },
      select: { id: true, name: true, summary: true },
      orderBy: { name: "asc" },
    }),
    hasStewardship(actor, "materialAdmin"),
    db.deviceLayer.findMany({
      where: { organizationId: actor.org },
      orderBy: { position: "asc" },
      select: { code: true, name: true, nameZh: true },
    }),
    db.materialCategoryDef.findMany({
      where: { organizationId: actor.org },
      select: { code: true, layers: true },
    }),
  ]);
  if (!experiment) return null;
  const involved =
    experiment.createdById === actor.uid ||
    experiment.members.some((member) => member.userId === actor.uid);
  const canEdit =
    actor.role === "ADMIN" || (actor.role === "MANAGER" && involved);
  return {
    experiment,
    processes,
    equipment,
    materials,
    environments,
    presets,
    orgUsers,
    recipes,
    canManageMaterials,
    layers,
    categoryLayers,
    canEdit,
  };
}

export async function getCaptureExperiment(actor: Actor, rawId: unknown) {
  const id = experimentIdSchema.parse(rawId);
  return db.experiment.findFirst({
    where: { AND: [{ id }, experimentVisibilityScope(actor, true)] },
    include: experimentInclude,
  });
}

export async function getCaptureRunData(
  actor: Actor,
  rawExperimentId: unknown,
  rawRunId?: unknown,
) {
  const experimentId = experimentIdSchema.parse(rawExperimentId);
  const runId = rawRunId ? experimentIdSchema.parse(rawRunId) : undefined;
  const [runs, layers] = await Promise.all([
    db.run.findMany({
      where: { experimentId, status: { not: "CANCELLED" } },
      orderBy: { runNo: "asc" },
    }),
    db.deviceLayer.findMany({
      where: { organizationId: actor.org },
      orderBy: { position: "asc" },
      select: { code: true, name: true },
    }),
  ]);
  const run = runs.find((row) => row.id === runId) ?? runs.at(-1);
  if (!run) throw new Error("Experiment has no capture run.");
  const [executions, results] = await Promise.all([
    db.stepExecution.findMany({
      where: { runId: run.id },
      include: { attachments: true },
    }),
    db.characterizationResult.findMany({
      where: {
        characterization: { experimentId },
        OR: [{ runId: run.id }, { runId: null }],
      },
    }),
  ]);
  return { runs, run, executions, results, layers };
}

export async function getResultsExperiment(actor: Actor, rawId: unknown) {
  const id = experimentIdSchema.parse(rawId);
  return db.experiment.findFirst({
    where: { AND: [{ id }, experimentVisibilityScope(actor, true)] },
    include: {
      members: { select: { userId: true } },
      samples: { orderBy: { code: "asc" } },
      characterizations: {
        orderBy: { position: "asc" },
        include: {
          process: true,
          results: {
            where: {
              OR: [
                { runId: null },
                { run: { is: { status: { not: "CANCELLED" } } } },
              ],
            },
            include: { run: true },
          },
        },
      },
      steps: {
        include: {
          process: true,
          parameters: { include: { variations: true } },
        },
      },
    },
  });
}

export async function getReportExperiment(actor: Actor, rawId: unknown) {
  const id = experimentIdSchema.parse(rawId);
  return db.experiment.findFirst({
    where: { AND: [{ id }, experimentVisibilityScope(actor, true)] },
    include: {
      createdBy: { select: { name: true } },
      assignee: { select: { name: true } },
      approvedBy: { select: { name: true } },
      members: { include: { user: { select: { id: true, name: true } } } },
      samples: { orderBy: { code: "asc" } },
      steps: {
        orderBy: { position: "asc" },
        include: {
          process: true,
          equipment: true,
          environment: true,
          materials: {
            orderBy: { position: "asc" },
            include: { material: true },
          },
          parameters: {
            orderBy: { position: "asc" },
            include: { variations: true },
          },
        },
      },
      characterizations: {
        orderBy: { position: "asc" },
        include: {
          process: true,
          equipment: true,
          results: {
            where: {
              OR: [
                { runId: null },
                { run: { is: { status: { not: "CANCELLED" } } } },
              ],
            },
            include: { run: true },
          },
        },
      },
      runs: {
        where: { status: { not: "CANCELLED" } },
        orderBy: { runNo: "asc" },
        include: { executions: true },
      },
      labels: { include: { label: true } },
    },
  });
}

export async function getExperimentCode(actor: Actor, rawId: unknown) {
  const id = experimentIdSchema.parse(rawId);
  return db.experiment.findFirst({
    where: { AND: [{ id }, experimentVisibilityScope(actor, true)] },
    select: { code: true },
  });
}
