import "server-only";
import { fmtBeijing } from "@/lib/datetime";

import { db } from "@/infrastructure/db/client";
import { buildCaptureChoiceCatalog } from "@/lib/capture-fields";
import { experimentInclude } from "@/lib/types";
import type { Actor } from "@/modules/authorization/actor";
import {
  canManageExperiment,
  canReadExperiment,
} from "@/modules/authorization/policy";
import {
  experimentListScope,
  experimentVisibilityScope,
} from "@/modules/authorization/scope";
import { experimentIdSchema } from "./schema";
import { getStewardships } from "@/modules/stewardship/service";
import { canReadRecipeContents } from "@/modules/library/recipe-policy";

export async function listDashboardExperiments(actor: Actor) {
  // The whole lab's board: everyone sees every card; opening is gated.
  const rows = await db.experiment.findMany({
    where: experimentListScope(actor),
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
  const staff = actor.role === "ADMIN" || actor.role === "MANAGER";
  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    title: row.title,
    status: row.status,
    // Whether clicking the card opens it (vs. the request-access page).
    openable:
      staff ||
      row.createdById === actor.uid ||
      row.assigneeId === actor.uid ||
      row.members.some((member) => member.userId === actor.uid),
    // Whether this actor may change it (drag, rename, delete): staff, or the
    // technician who created it or is assigned to run it.
    editable:
      staff || row.createdById === actor.uid || row.assigneeId === actor.uid,
    isTemplate: row.templatePinnedAt !== null,
    createdBy: row.createdBy.name,
    members: row.members.map((member) => member.user.name),
    labels: row.labels.map((label) => label.label.name),
    campaign: row.campaign,
    samples: row._count.samples,
    steps: row._count.steps,
    characterizations: row._count.characterizations,
    updatedAt: fmtBeijing(row.updatedAt, "date"),
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
    stewardships,
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
      select: {
        id: true,
        name: true,
        summary: true,
        organizationId: true,
        createdById: true,
        approvalStatus: true,
      },
      orderBy: { name: "asc" },
    }),
    getStewardships(actor),
    db.deviceLayer.findMany({
      where: { organizationId: actor.org },
      orderBy: { position: "asc" },
      select: { code: true, name: true, nameZh: true },
    }),
    // Full rows: the designer both filters dropdowns by layer and feeds the
    // in-page "add material" modal, which needs the display names.
    db.materialCategoryDef.findMany({
      where: { organizationId: actor.org },
      orderBy: { position: "asc" },
      select: {
        id: true,
        code: true,
        name: true,
        nameZh: true,
        builtIn: true,
        layers: true,
      },
    }),
  ]);
  if (!experiment) return null;
  // The one edit-rights answer lives in policy: staff manage everything,
  // technicians manage what they created. A stale pre-revamp copy of this
  // rule here once locked technicians out of their own designers (2026-09-08).
  const canEdit = canManageExperiment(actor, experiment);
  return {
    experiment,
    processes,
    equipment,
    materials,
    environments,
    presets,
    orgUsers,
    recipes: recipes.map((recipe) => ({
      id: recipe.id,
      name: recipe.name,
      summary: canReadRecipeContents(actor, recipe, stewardships)
        ? recipe.summary
        : "",
    })),
    canManageMaterials: true,
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
  const [runs, layers, materials, categoryLayers, captureProcesses] =
    await Promise.all([
      db.run.findMany({
        where: { experimentId, status: { not: "CANCELLED" } },
        orderBy: { runNo: "asc" },
      }),
      db.deviceLayer.findMany({
        where: { organizationId: actor.org },
        orderBy: { position: "asc" },
        select: { code: true, name: true },
      }),
      db.material.findMany({
        where: { organizationId: actor.org, archived: false },
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          processId: true,
          category: true,
        },
      }),
      db.materialCategoryDef.findMany({
        where: { organizationId: actor.org },
        select: { code: true, layers: true },
      }),
      db.process.findMany({
        where: {
          organizationId: actor.org,
          archived: false,
          kind: "PROCESSING",
        },
        select: {
          id: true,
          parameters: true,
          equipment: {
            where: { archived: false },
            select: { parameters: true },
          },
          presets: {
            where: { kind: "STEP" },
            select: { payload: true },
          },
        },
      }),
    ]);
  const run = runs.find((row) => row.id === runId) ?? runs.at(-1);
  if (!run) throw new Error("Experiment has no capture run.");
  const [executions, results] = await Promise.all([
    db.stepExecution.findMany({
      where: { runId: run.id },
      include: { attachments: true, materialSelections: true },
    }),
    db.characterizationResult.findMany({
      where: {
        characterization: { experimentId },
        OR: [{ runId: run.id }, { runId: null }],
      },
    }),
  ]);
  return {
    runs,
    run,
    executions,
    results,
    layers,
    materials,
    categoryLayers,
    captureChoiceCatalog: buildCaptureChoiceCatalog(captureProcesses),
  };
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

/** Everything the printable label sheet needs — nothing more. */
export async function getLabelSheetData(actor: Actor, rawId: unknown) {
  const id = experimentIdSchema.parse(rawId);
  return db.experiment.findFirst({
    where: { AND: [{ id }, experimentVisibilityScope(actor, true)] },
    select: {
      id: true,
      code: true,
      shortCode: true,
      title: true,
      samples: {
        orderBy: { code: "asc" },
        select: { id: true, code: true, simCode: true, variationGroup: true },
      },
    },
  });
}

/**
 * Where a scanned label QR should land. Null when the sample does not exist
 * in the actor's organization; `canRead: false` sends the scanner to the
 * experiment page, which renders the request-access peek.
 */
export async function resolveSampleScan(
  actor: Actor,
  rawSampleId: unknown,
): Promise<{ experimentId: string; canRead: boolean } | null> {
  const sampleId = experimentIdSchema.parse(rawSampleId);
  const sample = await db.sample.findFirst({
    where: {
      id: sampleId,
      experiment: { organizationId: actor.org, deletedAt: null },
    },
    select: {
      experiment: {
        select: {
          id: true,
          organizationId: true,
          createdById: true,
          assigneeId: true,
          members: { select: { userId: true } },
        },
      },
    },
  });
  if (!sample) return null;
  return {
    experimentId: sample.experiment.id,
    canRead: canReadExperiment(actor, sample.experiment),
  };
}
