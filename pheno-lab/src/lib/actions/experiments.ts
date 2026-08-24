"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ExperimentStatus, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireSession, requireStaff, type Session } from "@/lib/auth";
import type { TestPlan } from "@/lib/library";
import type { StepDraft, CharDraft, StepPresetPayload, CharPresetPayload } from "@/lib/types";
import { experimentInclude } from "@/lib/types";
import { refreshExperimentSerials, syncSampleSerials } from "@/lib/instruments/assign";

// ---- Access control ----
//
// ADMIN: sees and edits every experiment in the organization.
// MANAGER: sees and edits experiments they created or are a member of.
// TECHNICIAN: read-only, and only experiments they are a member of.

/**
 * Which experiments this person may see.
 *
 * Test runs are excluded here so every real view — board, data table, portal,
 * profile stats — is clean by construction. Pass includeTest for the Test data
 * page, which is the one place they belong.
 */
export async function canViewWhere(
  session: Session,
  includeTest = false
): Promise<Prisma.ExperimentWhereInput> {
  const base: Prisma.ExperimentWhereInput = includeTest
    ? { organizationId: session.org }
    : { organizationId: session.org, isTest: false };
  if (session.role === "ADMIN") return base;
  if (session.role === "MANAGER")
    return { ...base, OR: [{ createdById: session.uid }, { members: { some: { userId: session.uid } } }] };
  return { ...base, members: { some: { userId: session.uid } } };
}

async function assertEdit(experimentId: string): Promise<Session> {
  const session = await requireStaff();
  const exp = await db.experiment.findUniqueOrThrow({
    where: { id: experimentId },
    select: { organizationId: true, createdById: true, members: { select: { userId: true } } },
  });
  if (exp.organizationId !== session.org) throw new Error("Experiment belongs to another organization.");
  if (session.role === "ADMIN") return session;
  if (exp.createdById === session.uid || exp.members.some((m) => m.userId === session.uid)) return session;
  throw new Error("You do not have edit access to this experiment.");
}

async function assertEditByStep(stepId: string) {
  const step = await db.processStep.findUniqueOrThrow({ where: { id: stepId }, select: { experimentId: true } });
  await assertEdit(step.experimentId);
  return step;
}

async function assertEditByChar(charId: string) {
  const c = await db.characterization.findUniqueOrThrow({ where: { id: charId }, select: { experimentId: true } });
  await assertEdit(c.experimentId);
  return c;
}

// ---- Experiment ----

// Experiment codes are YYYY-ORG-USER-SEQ: year, organization number (Pheno =
// 001), the creator's user number, and their monotonically increasing
// experiment sequence — never reused, no ceiling, unique across the org.
async function nextExperimentCode(session: Session): Promise<string> {
  const [org, user] = await db.$transaction([
    db.organization.findUniqueOrThrow({ where: { id: session.org }, select: { orgNumber: true } }),
    db.user.update({ where: { id: session.uid }, data: { nextExpSeq: { increment: 1 } } }),
  ]);
  const seq = user.nextExpSeq - 1;
  return `${new Date().getFullYear()}-${String(org.orgNumber).padStart(3, "0")}-${user.userNumber}-${seq}`;
}

export async function createExperiment(isTest = false) {
  const session = await requireStaff();
  const code = await nextExperimentCode(session);
  const exp = await db.experiment.create({
    data: {
      organizationId: session.org,
      code,
      title: isTest ? "Untitled test experiment" : "Untitled experiment",
      isTest,
      createdById: session.uid,
      samples: { create: [{ code: "S1" }, { code: "S2" }, { code: "S3" }, { code: "S4" }] },
    },
  });
  // Give the experiment its short handle and each sample its instrument serial.
  await syncSampleSerials(db, exp.id);
  revalidatePath("/");
  redirect(`/experiments/${exp.id}`);
}

export async function updateExperimentMeta(
  id: string,
  data: Partial<{ title: string; campaign: string; observation: string; problem: string; hypothesis: string; conclusion: string; status: ExperimentStatus }>
) {
  await assertEdit(id);
  await db.experiment.update({ where: { id }, data });
  revalidatePath("/");
}

export async function deleteExperiment(id: string) {
  await assertEdit(id);
  await db.experiment.delete({ where: { id } });
  revalidatePath("/");
}

/** Phase 2: duplicate an experiment as a template — full plan, no run data. */
export async function duplicateExperiment(id: string) {
  const session = await requireStaff();
  const src = await db.experiment.findUniqueOrThrow({ where: { id }, include: experimentInclude });
  if (src.organizationId !== session.org) throw new Error("Experiment belongs to another organization.");

  const code = await nextExperimentCode(session);

  const copy = await db.experiment.create({
    data: {
      organizationId: session.org,
      code,
      title: `${src.title} (copy)`,
      campaign: src.campaign,
      status: "DRAFT",
      observation: src.observation,
      problem: src.problem,
      hypothesis: src.hypothesis,
      metadata: src.metadata ?? undefined,
      createdById: session.uid,
      members: { create: [{ userId: session.uid }] },
      // Serials are NOT copied: the duplicate is a different experiment and
      // gets its own short handle, or both would answer to the same serial.
      samples: { create: src.samples.map((sm) => ({ code: sm.code, variationGroup: sm.variationGroup })) },
    },
  });
  await syncSampleSerials(db, copy.id);

  for (const st of src.steps) {
    await db.processStep.create({
      data: {
        experimentId: copy.id,
        position: st.position,
        processId: st.processId,
        name: st.name,
        equipmentId: st.equipmentId,
        environmentId: st.environmentId,
        environmentConditions: st.environmentConditions ?? undefined,
        notes: st.notes,
        materials: { create: st.materials.map((m) => ({ materialId: m.materialId, amount: m.amount, position: m.position })) },
        parameters: {
          create: st.parameters.map((pp) => ({
            position: pp.position,
            name: pp.name,
            unit: pp.unit,
            value: pp.value,
            source: pp.source,
            variations: { create: pp.variations.map((v) => ({ variationGroup: v.variationGroup, value: v.value })) },
          })),
        },
      },
    });
  }
  for (const c of src.characterizations) {
    await db.characterization.create({
      data: {
        experimentId: copy.id,
        position: c.position,
        processId: c.processId,
        name: c.name,
        equipmentId: c.equipmentId,
        environmentId: c.environmentId,
        environmentConditions: c.environmentConditions ?? undefined,
        settings: c.settings ?? undefined,
        sampleScope: c.sampleScope,
        notes: c.notes,
      },
    });
  }
  await syncAutoLabels(copy.id);
  revalidatePath("/");
  return { id: copy.id, code: copy.code };
}


// ---- Members / access ----

export async function addMember(experimentId: string, userId: string) {
  const session = await assertEdit(experimentId);
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { organizationId: true } });
  if (user.organizationId !== session.org) throw new Error("User belongs to another organization.");
  await db.experimentMember.upsert({
    where: { experimentId_userId: { experimentId, userId } },
    update: {},
    create: { experimentId, userId },
  });
  return db.experimentMember.findMany({
    where: { experimentId },
    include: { user: { select: { id: true, name: true, email: true, role: true } } },
  });
}

export async function removeMember(experimentId: string, userId: string) {
  await assertEdit(experimentId);
  await db.experimentMember.deleteMany({ where: { experimentId, userId } });
  return db.experimentMember.findMany({
    where: { experimentId },
    include: { user: { select: { id: true, name: true, email: true, role: true } } },
  });
}

// ---- Samples ----

export async function setSamples(
  experimentId: string,
  samples: { code: string; variationGroup: string | null }[]
) {
  await assertEdit(experimentId);
  await db.$transaction(async (tx) => {
    await tx.sample.deleteMany({ where: { experimentId } });
    await tx.sample.createMany({
      data: samples.map((s) => ({ experimentId, code: s.code, variationGroup: s.variationGroup })),
    });
    await syncSampleSerials(tx, experimentId);
  });
  // Rebuilding the sample set strands any measurement that pointed at the old
  // rows; re-matching puts them back on the same serial.
  await refreshExperimentSerials(experimentId);
  return db.sample.findMany({ where: { experimentId }, orderBy: { code: "asc" } });
}

// ---- Process steps ----

const fullStepInclude = {
  process: true,
  equipment: true,
  environment: true,
  materials: { orderBy: { position: "asc" as const }, include: { material: true } },
  parameters: { orderBy: { position: "asc" as const }, include: { variations: true } },
};

export async function addStep(experimentId: string, processId: string) {
  const session = await assertEdit(experimentId);
  const process = await db.process.findUniqueOrThrow({ where: { id: processId } });
  if (process.organizationId !== session.org) throw new Error("Process belongs to another organization.");
  const count = await db.processStep.count({ where: { experimentId } });
  const defs = Array.isArray(process.parameters) ? (process.parameters as { name: string; unit: string; defaultValue: string }[]) : [];
  return db.processStep.create({
    data: {
      experimentId, position: count, processId, name: process.name,
      layer: process.defaultLayer,
      parameters: { create: defs.map((d, i) => ({ position: i, name: d.name, unit: d.unit, value: d.defaultValue, source: "process" })) },
    },
    include: fullStepInclude,
  });
}

/** Single write for the inspector's "Save changes": the whole step draft. */
export async function saveStep(stepId: string, draft: StepDraft, appliedPresetId?: string | null) {
  await assertEditByStep(stepId);
  await db.$transaction(async (tx) => {
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
      await tx.stepMaterial.create({ data: { stepId, materialId: m.materialId, amount: m.amount, position: mi++ } });
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
          variations: { create: p.variations.filter((v) => v.value.trim() !== "") },
        },
      });
    }
  });
  if (appliedPresetId) {
    await db.preset.update({ where: { id: appliedPresetId }, data: { usageCount: { increment: 1 } } }).catch(() => {});
  }
  const saved = await db.processStep.findUniqueOrThrow({ where: { id: stepId }, include: fullStepInclude });
  await syncAutoLabels(saved.experimentId);
  return saved;
}

// Labels are generated automatically from what the experiment actually uses:
// processes, equipment, materials, and tested variables.
async function syncAutoLabels(experimentId: string) {
  const exp = await db.experiment.findUnique({
    where: { id: experimentId },
    include: {
      steps: { include: { process: true, equipment: true, materials: { include: { material: true } } } },
      characterizations: { include: { process: true } },
    },
  });
  if (!exp) return;
  const plan = (exp.metadata as { testPlan?: TestPlan } | null)?.testPlan;
  const names = new Set<string>();
  for (const st of exp.steps) {
    names.add(st.process.name);
    if (st.equipment) names.add(st.equipment.name.split("—")[0].trim());
    for (const m of st.materials) names.add(m.material.name.split("—")[0].trim());
  }
  for (const c of exp.characterizations) names.add(c.process.name);
  for (const v of plan?.variables ?? []) names.add(`var:${v.parameter}`);

  await db.experimentLabel.deleteMany({ where: { experimentId } });
  for (const name of names) {
    const label = await db.label.upsert({
      where: { organizationId_name: { organizationId: exp.organizationId, name } },
      update: {},
      create: { organizationId: exp.organizationId, name },
    });
    await db.experimentLabel.create({ data: { experimentId, labelId: label.id } });
  }
}

export async function deleteStep(stepId: string) {
  const { experimentId } = await assertEditByStep(stepId);
  await db.processStep.delete({ where: { id: stepId } });
  const rest = await db.processStep.findMany({ where: { experimentId }, orderBy: { position: "asc" } });
  await Promise.all(rest.map((s, i) => db.processStep.update({ where: { id: s.id }, data: { position: i } })));
}

/** Reorder from the sandbox: full ordered list of step ids. */
export async function reorderSteps(experimentId: string, orderedIds: string[]) {
  await assertEdit(experimentId);
  await db.$transaction(
    orderedIds.map((id, i) =>
      db.processStep.update({ where: { id, experimentId }, data: { position: i } })
    )
  );
}

// ---- Characterizations ----

export async function addCharacterization(experimentId: string, processId: string) {
  const session = await assertEdit(experimentId);
  const process = await db.process.findUniqueOrThrow({ where: { id: processId } });
  if (process.organizationId !== session.org) throw new Error("Process belongs to another organization.");
  const count = await db.characterization.count({ where: { experimentId } });
  return db.characterization.create({
    data: { experimentId, position: count, processId, name: process.name, settings: {}, sampleScope: "all" },
    include: { process: true, equipment: true, environment: true },
  });
}

export async function saveCharacterization(id: string, draft: CharDraft, appliedPresetId?: string | null) {
  await assertEditByChar(id);
  const char = await db.characterization.update({
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
    await db.preset.update({ where: { id: appliedPresetId }, data: { usageCount: { increment: 1 } } }).catch(() => {});
  }
  return char;
}

export async function deleteCharacterization(id: string) {
  await assertEditByChar(id);
  await db.characterization.delete({ where: { id } });
}

// ---- Presets ----

export async function saveStepPreset(name: string, processId: string, payload: StepPresetPayload) {
  const session = await requireStaff();
  return db.preset.create({
    data: {
      organizationId: session.org,
      kind: "STEP",
      processId,
      name,
      payload: payload as unknown as Prisma.InputJsonValue,
      createdById: session.uid,
    },
  });
}

export async function saveCharPreset(name: string, processId: string, payload: CharPresetPayload) {
  const session = await requireStaff();
  return db.preset.create({
    data: {
      organizationId: session.org,
      kind: "CHARACTERIZATION",
      processId,
      name,
      payload: payload as unknown as Prisma.InputJsonValue,
      createdById: session.uid,
    },
  });
}

export async function deletePreset(id: string) {
  const session = await requireStaff();
  await db.preset.deleteMany({ where: { id, organizationId: session.org } });
  revalidatePath("/library");
}

// ---- Quick-create from the designer ----

export async function quickCreateMaterial(name: string, processId: string | null) {
  // Materials are curated: only material administrators (or org admins) add.
  const session = await requireStaff();
  const user = await db.user.findUniqueOrThrow({ where: { id: session.uid } });
  if (session.role !== "ADMIN" && !user.materialAdmin) {
    throw new Error("Only material administrators can add materials.");
  }
  return db.material.create({
    data: { organizationId: session.org, name: name.trim(), processId },
  });
}

// ---- Test plan ----
//
// Global groups (rows) x variables (columns). Each variable is a process
// parameter or a material choice varied per group. Applying regenerates the
// sample set, wires each variable onto its process step (created if missing),
// and removes variations left over from a previous plan.

export async function applyTestPlan(experimentId: string, plan: TestPlan) {
  const session = await assertEdit(experimentId);
  const groups = plan.groups.filter((g) => g.label.trim() && g.samples > 0);
  if (groups.length === 0) throw new Error("The test plan needs at least one group.");
  const variables = plan.variables.filter((v) => v.parameter.trim() && v.processId);
  const control = groups.find((g) => g.isControl) ?? groups[0];

  for (const v of variables) {
    const process = await db.process.findUniqueOrThrow({ where: { id: v.processId } });
    if (process.organizationId !== session.org) throw new Error("Process belongs to another organization.");
  }

  const expBefore = await db.experiment.findUniqueOrThrow({
    where: { id: experimentId },
    select: { metadata: true },
  });
  const oldPlan = (expBefore.metadata as { testPlan?: TestPlan } | null)?.testPlan;

  await db.$transaction(async (tx) => {
    // 1. Remove variations wired by the previous plan that are no longer part
    //    of the new plan (e.g. the tested process was changed).
    for (const old of oldPlan?.variables ?? []) {
      const stillThere = variables.some(
        (v) => v.processId === old.processId && v.parameter.toLowerCase() === old.parameter.toLowerCase()
      );
      if (stillThere) continue;
      const oldSteps = await tx.processStep.findMany({
        where: { experimentId, processId: old.processId },
        include: { parameters: true },
      });
      for (const st of oldSteps) {
        const param = st.parameters.find((pp) => pp.name.toLowerCase() === old.parameter.toLowerCase());
        if (!param) continue;
        await tx.parameterVariation.deleteMany({ where: { parameterId: param.id } });
        if (param.source === "material") {
          // material variable rows were created by the plan — remove entirely
          await tx.stepParameter.delete({ where: { id: param.id } });
        }
      }
    }

    // 2. Regenerate samples: replicates per group, sequential codes.
    await tx.sample.deleteMany({ where: { experimentId } });
    let n = 0;
    for (const g of groups) {
      for (let i = 0; i < g.samples; i++) {
        n += 1;
        await tx.sample.create({ data: { experimentId, code: `S${n}`, variationGroup: g.label } });
      }
    }
    await syncSampleSerials(tx, experimentId);

    // 3. Wire each variable onto its process step.
    for (const v of variables) {
      // Prefer the step already running on the machine named by the variable.
      let step = v.equipmentId
        ? await tx.processStep.findFirst({
            where: { experimentId, processId: v.processId, equipmentId: v.equipmentId },
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
        const process = await tx.process.findUniqueOrThrow({ where: { id: v.processId } });
        const count = await tx.processStep.count({ where: { experimentId } });
        const defs = Array.isArray(process.parameters) ? (process.parameters as { name: string; unit: string; defaultValue: string }[]) : [];
        step = await tx.processStep.create({
          data: {
            experimentId, position: count, processId: v.processId, name: process.name,
            equipmentId: v.equipmentId || null,
            layer: v.layer || process.defaultLayer,
            parameters: { create: defs.map((d, i) => ({ position: i, name: d.name, unit: d.unit, value: d.defaultValue, source: "process" })) },
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

      let param = step.parameters.find((pp) => pp.name.toLowerCase() === v.parameter.toLowerCase());
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
          data: { value: v.values[control.label] ?? param.value, unit: v.unit || param.unit },
        });
      }
      await tx.parameterVariation.deleteMany({ where: { parameterId: param.id } });
      await tx.parameterVariation.createMany({
        data: groups.map((g) => ({ parameterId: param!.id, variationGroup: g.label, value: v.values[g.label] ?? "" })),
      });
    }

    // 4. Persist the plan.
    const metadata = { ...((expBefore.metadata as object) ?? {}), testPlan: { groups, variables } };
    await tx.experiment.update({ where: { id: experimentId }, data: { metadata } });
  });

  await syncAutoLabels(experimentId);
  // The plan rebuilt the samples: re-attach measurements that were pointing at
  // the old rows. Serials are derived, so they land on the same samples.
  await refreshExperimentSerials(experimentId);
  return db.experiment.findUniqueOrThrow({ where: { id: experimentId }, include: experimentInclude });
}

// ---- Preset editing ----
//
// Admin and managers can edit any preset; technicians only their own.

export async function updatePreset(
  id: string,
  data: { name?: string; payload?: StepPresetPayload | CharPresetPayload }
) {
  const session = await requireSession();
  const preset = await db.preset.findUniqueOrThrow({ where: { id } });
  if (preset.organizationId !== session.org) throw new Error("Preset belongs to another organization.");
  if (session.role === "TECHNICIAN" && preset.createdById !== session.uid) {
    throw new Error("Technicians can only edit their own presets.");
  }
  await db.preset.update({
    where: { id },
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.payload !== undefined ? { payload: data.payload as unknown as Prisma.InputJsonValue } : {}),
    },
  });
  revalidatePath("/library");
}


// ---- Test data ----
//
// Test runs are real rows carrying `isTest`, not a second database: the
// library they reference (materials, equipment, recipes) is shared, and a
// separate database would have to duplicate all of it or break those links.
// The flag gives the same practical result — test work never appears in a
// real view, and it can be cleared in one action.

/** Test experiments, for the Test data view. */
export async function listTestExperiments() {
  const session = await requireSession();
  return db.experiment.findMany({
    where: { organizationId: session.org, isTest: true },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, code: true, title: true, status: true, createdAt: true,
      createdBy: { select: { name: true } },
      _count: { select: { samples: true, steps: true, runs: true } },
    },
  });
}

/** Move an experiment between the test and real spaces. */
export async function setExperimentTestMode(id: string, isTest: boolean) {
  await assertEdit(id);
  await db.experiment.update({ where: { id }, data: { isTest } });
  revalidatePath("/");
  revalidatePath("/test-data");
}

/**
 * Delete every test experiment in the organization.
 *
 * Admin-only and irreversible. Cascades take the samples, steps, runs,
 * executions and results with them; nothing marked real is touched, and the
 * count is returned so the caller can report exactly what went.
 */
export async function clearTestData(): Promise<number> {
  const session = await requireSession();
  if (session.role !== "ADMIN") throw new Error("Only an administrator can clear test data.");
  const { count } = await db.experiment.deleteMany({
    where: { organizationId: session.org, isTest: true },
  });
  revalidatePath("/");
  revalidatePath("/test-data");
  return count;
}
