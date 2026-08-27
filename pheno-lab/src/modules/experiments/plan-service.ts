import "server-only";

import type { Prisma } from "@prisma/client";
import { db } from "@/infrastructure/db/client";
import type { TestPlan } from "@/lib/library";
import { experimentInclude } from "@/lib/types";
import type { Actor } from "@/modules/authorization/actor";
import { recordUserAudit } from "@/modules/audit/writer";
import {
  refreshExperimentSerials,
  syncSampleSerials,
} from "@/modules/instruments/sample-serial-service";
import { assertEdit, assertEditByChar, assertEditByStep } from "./access";
import {
  characterizationDraftSchema,
  charPresetPayloadSchema,
  experimentIdSchema,
  orderedIdsSchema,
  stepDraftSchema,
  stepPresetPayloadSchema,
  testPlanSchema,
} from "./schema";

// ---- Process steps ----

const fullStepInclude = {
  process: true,
  equipment: true,
  environment: true,
  materials: {
    orderBy: { position: "asc" as const },
    include: { material: true },
  },
  parameters: {
    orderBy: { position: "asc" as const },
    include: { variations: true },
  },
};

async function assertStepReferences(
  tx: Prisma.TransactionClient,
  actor: Actor,
  processId: string,
  draft: ReturnType<typeof stepDraftSchema.parse>,
) {
  const [equipment, environment, recipe, materialCount] = await Promise.all([
    draft.equipmentId
      ? tx.equipment.findFirst({
          where: {
            id: draft.equipmentId,
            organizationId: actor.org,
            processId,
          },
          select: { id: true },
        })
      : null,
    draft.environmentId
      ? tx.labEnvironment.findFirst({
          where: { id: draft.environmentId, organizationId: actor.org },
          select: { id: true },
        })
      : null,
    draft.recipeId
      ? tx.recipe.findFirst({
          where: { id: draft.recipeId, organizationId: actor.org },
          select: { id: true },
        })
      : null,
    tx.material.count({
      where: {
        id: { in: [...new Set(draft.materials.map((row) => row.materialId))] },
        organizationId: actor.org,
      },
    }),
  ]);
  if (draft.equipmentId && !equipment)
    throw new Error(
      "Equipment does not belong to this process and organization.",
    );
  if (draft.environmentId && !environment)
    throw new Error("Environment belongs to another organization.");
  if (draft.recipeId && !recipe)
    throw new Error("Recipe belongs to another organization.");
  const uniqueMaterials = new Set(draft.materials.map((row) => row.materialId));
  if (materialCount !== uniqueMaterials.size)
    throw new Error("One or more materials belong to another organization.");
}

async function assertCharacterizationReferences(
  tx: Prisma.TransactionClient,
  actor: Actor,
  processId: string,
  draft: ReturnType<typeof characterizationDraftSchema.parse>,
) {
  const [equipment, environment] = await Promise.all([
    draft.equipmentId
      ? tx.equipment.findFirst({
          where: {
            id: draft.equipmentId,
            organizationId: actor.org,
            processId,
          },
          select: { id: true },
        })
      : null,
    draft.environmentId
      ? tx.labEnvironment.findFirst({
          where: { id: draft.environmentId, organizationId: actor.org },
          select: { id: true },
        })
      : null,
  ]);
  if (draft.equipmentId && !equipment)
    throw new Error(
      "Equipment does not belong to this process and organization.",
    );
  if (draft.environmentId && !environment)
    throw new Error("Environment belongs to another organization.");
}

export async function assertPresetReferences(
  tx: Prisma.TransactionClient,
  actor: Actor,
  processId: string,
  payload:
    | ReturnType<typeof stepPresetPayloadSchema.parse>
    | ReturnType<typeof charPresetPayloadSchema.parse>,
) {
  const process = await tx.process.findFirst({
    where: { id: processId, organizationId: actor.org },
    select: { id: true },
  });
  if (!process) throw new Error("Process belongs to another organization.");
  if (payload.equipmentId) {
    const equipment = await tx.equipment.count({
      where: {
        id: payload.equipmentId,
        organizationId: actor.org,
        processId,
      },
    });
    if (!equipment)
      throw new Error(
        "Equipment does not belong to this process and organization.",
      );
  }
  if (payload.environmentId) {
    const environment = await tx.labEnvironment.count({
      where: { id: payload.environmentId, organizationId: actor.org },
    });
    if (!environment)
      throw new Error("Environment belongs to another organization.");
  }
  if ("materials" in payload) {
    const ids = [...new Set(payload.materials.map((row) => row.materialId))];
    const materials = await tx.material.count({
      where: { id: { in: ids }, organizationId: actor.org },
    });
    if (materials !== ids.length)
      throw new Error("One or more materials belong to another organization.");
  }
}

export async function addStep(
  actor: Actor,
  experimentId: string,
  processId: string,
) {
  experimentId = experimentIdSchema.parse(experimentId);
  processId = experimentIdSchema.parse(processId);
  await assertEdit(actor, experimentId);
  const process = await db.process.findUniqueOrThrow({
    where: { id: processId },
  });
  if (process.organizationId !== actor.org)
    throw new Error("Process belongs to another organization.");
  const defs = Array.isArray(process.parameters)
    ? (process.parameters as {
        name: string;
        unit: string;
        defaultValue: string;
      }[])
    : [];
  return db.$transaction(async (tx) => {
    const count = await tx.processStep.count({ where: { experimentId } });
    const row = await tx.processStep.create({
      data: {
        experimentId,
        position: count,
        processId,
        name: process.name,
        layer: process.defaultLayer,
        parameters: {
          create: defs.map((d, i) => ({
            position: i,
            name: d.name,
            unit: d.unit,
            value: d.defaultValue,
            source: "process",
          })),
        },
      },
      include: fullStepInclude,
    });
    await recordUserAudit(tx, {
      actor,
      action: "experiment.step.created",
      entityType: "ProcessStep",
      entityId: row.id,
      metadata: { experimentId, processId },
    });
    return row;
  });
}

/** Single write for the inspector's "Save changes": the whole step draft. */
export async function saveStep(
  actor: Actor,
  stepId: string,
  rawDraft: unknown,
  appliedPresetId?: string | null,
) {
  stepId = experimentIdSchema.parse(stepId);
  const draft = stepDraftSchema.parse(rawDraft);
  const step = await assertEditByStep(actor, stepId);
  await db.$transaction(async (tx) => {
    await assertStepReferences(tx, actor, step.processId, draft);
    await tx.processStep.update({
      where: { id: stepId },
      data: {
        name: draft.name,
        equipmentId: draft.equipmentId,
        environmentId: draft.environmentId,
        environmentConditions: draft.environmentConditions,
        recipeId: draft.recipeId,
        layer: draft.layer,
        notes: draft.notes,
      },
    });
    await tx.stepMaterial.deleteMany({ where: { stepId } });
    const seen = new Set<string>();
    let mi = 0;
    for (const m of draft.materials) {
      if (!m.materialId || seen.has(m.materialId)) continue;
      seen.add(m.materialId);
      await tx.stepMaterial.create({
        data: {
          stepId,
          materialId: m.materialId,
          amount: m.amount,
          position: mi++,
        },
      });
    }
    await tx.stepParameter.deleteMany({ where: { stepId } });
    for (let i = 0; i < draft.parameters.length; i++) {
      const p = draft.parameters[i];
      await tx.stepParameter.create({
        data: {
          stepId,
          position: i,
          name: p.name,
          unit: p.unit,
          value: p.value,
          source: p.source || "custom",
          variations: {
            create: p.variations.filter((v) => v.value.trim() !== ""),
          },
        },
      });
    }
    if (appliedPresetId) {
      await tx.preset.updateMany({
        where: { id: appliedPresetId, organizationId: actor.org },
        data: { usageCount: { increment: 1 } },
      });
    }
    await recordUserAudit(tx, {
      actor,
      action: "experiment.step.updated",
      entityType: "ProcessStep",
      entityId: stepId,
      changes: {
        name: draft.name,
        equipmentId: draft.equipmentId,
        environmentId: draft.environmentId,
        recipeId: draft.recipeId,
        materialIds: draft.materials.map((row) => row.materialId),
        parameterCount: draft.parameters.length,
      },
    });
  });
  const saved = await db.processStep.findUniqueOrThrow({
    where: { id: stepId },
    include: fullStepInclude,
  });
  await syncAutoLabels(saved.experimentId);
  return saved;
}

// Labels are generated automatically from what the experiment actually uses:
// processes, equipment, materials, and tested variables.
export async function syncAutoLabels(experimentId: string) {
  const exp = await db.experiment.findUnique({
    where: { id: experimentId },
    include: {
      steps: {
        include: {
          process: true,
          equipment: true,
          materials: { include: { material: true } },
        },
      },
      characterizations: { include: { process: true } },
    },
  });
  if (!exp) return;
  const plan = (exp.metadata as { testPlan?: TestPlan } | null)?.testPlan;
  const names = new Set<string>();
  for (const st of exp.steps) {
    names.add(st.process.name);
    if (st.equipment) names.add(st.equipment.name.split("—")[0].trim());
    for (const m of st.materials)
      names.add(m.material.name.split("—")[0].trim());
  }
  for (const c of exp.characterizations) names.add(c.process.name);
  for (const v of plan?.variables ?? []) names.add(`var:${v.parameter}`);

  await db.experimentLabel.deleteMany({ where: { experimentId } });
  for (const name of names) {
    const label = await db.label.upsert({
      where: {
        organizationId_name: { organizationId: exp.organizationId, name },
      },
      update: {},
      create: { organizationId: exp.organizationId, name },
    });
    await db.experimentLabel.create({
      data: { experimentId, labelId: label.id },
    });
  }
}

export async function deleteStep(actor: Actor, rawStepId: unknown) {
  const stepId = experimentIdSchema.parse(rawStepId);
  const { experimentId } = await assertEditByStep(actor, stepId);
  await db.$transaction(async (tx) => {
    await tx.processStep.delete({ where: { id: stepId } });
    const rest = await tx.processStep.findMany({
      where: { experimentId },
      orderBy: { position: "asc" },
    });
    for (let index = 0; index < rest.length; index += 1) {
      await tx.processStep.update({
        where: { id: rest[index].id },
        data: { position: index },
      });
    }
    await recordUserAudit(tx, {
      actor,
      action: "experiment.step.deleted",
      entityType: "ProcessStep",
      entityId: stepId,
      metadata: { experimentId },
    });
  });
  await syncAutoLabels(experimentId);
}

/** Reorder from the sandbox: full ordered list of step ids. */
export async function reorderSteps(
  actor: Actor,
  rawExperimentId: unknown,
  rawIds: unknown,
) {
  const experimentId = experimentIdSchema.parse(rawExperimentId);
  const orderedIds = orderedIdsSchema.parse(rawIds);
  await assertEdit(actor, experimentId);
  await db.$transaction(async (tx) => {
    const existing = await tx.processStep.findMany({
      where: { experimentId },
      select: { id: true },
    });
    if (
      existing.length !== orderedIds.length ||
      existing.some((row) => !orderedIds.includes(row.id))
    ) {
      throw new Error(
        "Ordered step ids must contain every experiment step exactly once.",
      );
    }
    for (let index = 0; index < orderedIds.length; index += 1) {
      await tx.processStep.update({
        where: { id: orderedIds[index], experimentId },
        data: { position: index },
      });
    }
    await recordUserAudit(tx, {
      actor,
      action: "experiment.steps.reordered",
      entityType: "Experiment",
      entityId: experimentId,
      changes: { orderedIds },
    });
  });
}

// ---- Characterizations ----

export async function addCharacterization(
  actor: Actor,
  experimentId: string,
  processId: string,
) {
  experimentId = experimentIdSchema.parse(experimentId);
  processId = experimentIdSchema.parse(processId);
  await assertEdit(actor, experimentId);
  const process = await db.process.findUniqueOrThrow({
    where: { id: processId },
  });
  if (process.organizationId !== actor.org)
    throw new Error("Process belongs to another organization.");
  return db.$transaction(async (tx) => {
    const count = await tx.characterization.count({ where: { experimentId } });
    const row = await tx.characterization.create({
      data: {
        experimentId,
        position: count,
        processId,
        name: process.name,
        settings: {},
        sampleScope: "all",
      },
      include: { process: true, equipment: true, environment: true },
    });
    await recordUserAudit(tx, {
      actor,
      action: "experiment.characterization.created",
      entityType: "Characterization",
      entityId: row.id,
      metadata: { experimentId, processId },
    });
    return row;
  });
}

export async function saveCharacterization(
  actor: Actor,
  id: string,
  rawDraft: unknown,
  appliedPresetId?: string | null,
) {
  id = experimentIdSchema.parse(id);
  const draft = characterizationDraftSchema.parse(rawDraft);
  const current = await assertEditByChar(actor, id);
  return db.$transaction(async (tx) => {
    await assertCharacterizationReferences(tx, actor, current.processId, draft);
    const row = await tx.characterization.update({
      where: { id },
      data: {
        name: draft.name,
        equipmentId: draft.equipmentId,
        environmentId: draft.environmentId,
        environmentConditions: draft.environmentConditions,
        settings: draft.settings,
        sampleScope: draft.sampleScope,
        notes: draft.notes,
      },
      include: { process: true, equipment: true, environment: true },
    });
    if (appliedPresetId) {
      await tx.preset.updateMany({
        where: { id: appliedPresetId, organizationId: actor.org },
        data: { usageCount: { increment: 1 } },
      });
    }
    await recordUserAudit(tx, {
      actor,
      action: "experiment.characterization.updated",
      entityType: "Characterization",
      entityId: id,
      changes: {
        name: draft.name,
        equipmentId: draft.equipmentId,
        environmentId: draft.environmentId,
        sampleScope: draft.sampleScope,
      },
    });
    return row;
  });
}

export async function deleteCharacterization(actor: Actor, rawId: unknown) {
  const id = experimentIdSchema.parse(rawId);
  const current = await assertEditByChar(actor, id);
  await db.$transaction(async (tx) => {
    await tx.characterization.delete({ where: { id } });
    await recordUserAudit(tx, {
      actor,
      action: "experiment.characterization.deleted",
      entityType: "Characterization",
      entityId: id,
      metadata: { experimentId: current.experimentId },
    });
  });
  await syncAutoLabels(current.experimentId);
}

// ---- Test plan ----
//
// Global groups (rows) x variables (columns). Each variable is a process
// parameter or a material choice varied per group. Applying regenerates the
// sample set, wires each variable onto its process step (created if missing),
// and removes variations left over from a previous plan.

export async function applyTestPlan(
  actor: Actor,
  rawExperimentId: unknown,
  rawPlan: unknown,
) {
  const experimentId = experimentIdSchema.parse(rawExperimentId);
  const plan = testPlanSchema.parse(rawPlan) as TestPlan;
  await assertEdit(actor, experimentId);
  const groups = plan.groups.filter(
    (g) => g.label.trim() && (plan.substrates ? true : g.samples > 0),
  );
  if (groups.length === 0)
    throw new Error("The test plan needs at least one group.");
  const variables = plan.variables.filter(
    (v) => v.parameter.trim() && v.processId,
  );
  const control = groups.find((g) => g.isControl) ?? groups[0];

  for (const v of variables) {
    const process = await db.process.findUniqueOrThrow({
      where: { id: v.processId },
    });
    if (process.organizationId !== actor.org)
      throw new Error("Process belongs to another organization.");
    if (v.equipmentId) {
      const equipment = await db.equipment.count({
        where: {
          id: v.equipmentId,
          organizationId: actor.org,
          processId: v.processId,
        },
      });
      if (!equipment)
        throw new Error(
          "Equipment does not belong to this process and organization.",
        );
    }
  }

  const expBefore = await db.experiment.findUniqueOrThrow({
    where: { id: experimentId },
    select: { metadata: true },
  });
  const oldPlan = (expBefore.metadata as { testPlan?: TestPlan } | null)
    ?.testPlan;

  await db.$transaction(async (tx) => {
    // 1. Remove variations wired by the previous plan that are no longer part
    //    of the new plan (e.g. the tested process was changed).
    for (const old of oldPlan?.variables ?? []) {
      const stillThere = variables.some(
        (v) =>
          v.processId === old.processId &&
          v.parameter.toLowerCase() === old.parameter.toLowerCase(),
      );
      if (stillThere) continue;
      const oldSteps = await tx.processStep.findMany({
        where: { experimentId, processId: old.processId },
        include: { parameters: true },
      });
      for (const st of oldSteps) {
        const param = st.parameters.find(
          (pp) => pp.name.toLowerCase() === old.parameter.toLowerCase(),
        );
        if (!param) continue;
        await tx.parameterVariation.deleteMany({
          where: { parameterId: param.id },
        });
        if (param.source === "material") {
          // material variable rows were created by the plan — remove entirely
          await tx.stepParameter.delete({ where: { id: param.id } });
        }
      }
    }

    // 2. Regenerate samples. With a substrate batch the technician drags
    //    chips between groups, so membership comes from plan.assignments
    //    (EXTRA → ungrouped spare, ERROR → scrapped); otherwise the legacy
    //    replicates-per-group generation applies.
    await tx.sample.deleteMany({ where: { experimentId } });
    if (plan.substrates?.count) {
      const labels = new Set(groups.map((g) => g.label));
      for (let i = 1; i <= plan.substrates.count; i++) {
        const code = `S${i}`;
        const zone = plan.assignments?.[code] ?? "EXTRA";
        await tx.sample.create({
          data: {
            experimentId,
            code,
            variationGroup: labels.has(zone)
              ? zone
              : zone === "ERROR"
                ? "ERROR"
                : null,
          },
        });
      }
    } else {
      let n = 0;
      for (const g of groups) {
        for (let i = 0; i < g.samples; i++) {
          n += 1;
          await tx.sample.create({
            data: { experimentId, code: `S${n}`, variationGroup: g.label },
          });
        }
      }
    }
    await syncSampleSerials(tx, experimentId);

    // 3. Wire each variable onto its process step.
    for (const v of variables) {
      // Prefer the step already running on the machine named by the variable.
      let step = v.equipmentId
        ? await tx.processStep.findFirst({
            where: {
              experimentId,
              processId: v.processId,
              equipmentId: v.equipmentId,
            },
            orderBy: { position: "asc" },
            include: { parameters: true },
          })
        : null;
      step ??= await tx.processStep.findFirst({
        where: { experimentId, processId: v.processId },
        orderBy: { position: "asc" },
        include: { parameters: true },
      });
      if (!step) {
        const process = await tx.process.findUniqueOrThrow({
          where: { id: v.processId },
        });
        const count = await tx.processStep.count({ where: { experimentId } });
        const defs = Array.isArray(process.parameters)
          ? (process.parameters as {
              name: string;
              unit: string;
              defaultValue: string;
            }[])
          : [];
        step = await tx.processStep.create({
          data: {
            experimentId,
            position: count,
            processId: v.processId,
            name: process.name,
            equipmentId: v.equipmentId || null,
            layer: v.layer || process.defaultLayer,
            parameters: {
              create: defs.map((d, i) => ({
                position: i,
                name: d.name,
                unit: d.unit,
                value: d.defaultValue,
                source: "process",
              })),
            },
          },
          include: { parameters: true },
        });
      } else if (v.equipmentId || v.layer) {
        // Keep the flow in sync with what the plan says is being tested.
        await tx.processStep.update({
          where: { id: step.id },
          data: {
            ...(v.equipmentId ? { equipmentId: v.equipmentId } : {}),
            ...(v.layer ? { layer: v.layer } : {}),
          },
        });
      }

      let param = step.parameters.find(
        (pp) => pp.name.toLowerCase() === v.parameter.toLowerCase(),
      );
      if (!param) {
        param = await tx.stepParameter.create({
          data: {
            stepId: step.id,
            position: step.parameters.length,
            name: v.parameter,
            unit: v.unit,
            value: v.values[control.label] ?? "",
            source: v.kind === "material" ? "material" : "custom",
          },
        });
      } else {
        await tx.stepParameter.update({
          where: { id: param.id },
          data: {
            value: v.values[control.label] ?? param.value,
            unit: v.unit || param.unit,
          },
        });
      }
      await tx.parameterVariation.deleteMany({
        where: { parameterId: param.id },
      });
      await tx.parameterVariation.createMany({
        data: groups.map((g) => ({
          parameterId: param!.id,
          variationGroup: g.label,
          value: v.values[g.label] ?? "",
        })),
      });
    }

    // 4. Persist the plan.
    const metadata = {
      ...((expBefore.metadata as object) ?? {}),
      testPlan: { groups, variables },
    };
    await tx.experiment.update({
      where: { id: experimentId },
      data: { metadata },
    });
    await recordUserAudit(tx, {
      actor,
      action: "experiment.test-plan.applied",
      entityType: "Experiment",
      entityId: experimentId,
      changes: {
        groups: groups.map((group) => ({
          label: group.label,
          samples: group.samples,
          isControl: group.isControl,
        })),
        variables: variables.map((variable) => ({
          kind: variable.kind,
          processId: variable.processId,
          equipmentId: variable.equipmentId,
          parameter: variable.parameter,
        })),
      },
    });
  });

  await syncAutoLabels(experimentId);
  // The plan rebuilt the samples: re-attach measurements that were pointing at
  // the old rows. Serials are derived, so they land on the same samples.
  await refreshExperimentSerials(experimentId);
  return db.experiment.findUniqueOrThrow({
    where: { id: experimentId },
    include: experimentInclude,
  });
}
