import { afterAll, expect, it } from "vitest";
import { db } from "@/infrastructure/db/client";
import { getResultsExperiment } from "@/modules/experiments/query";

afterAll(async () => {
  await db.$disconnect();
});

it("returns results in designer order while retaining organization scope and excluding cancelled runs", async () => {
  const suffix = crypto.randomUUID();
  const organization = await db.organization.create({
    data: { name: "Results test organization", slug: `results-${suffix}` },
  });
  const foreignOrganization = await db.organization.create({
    data: {
      name: "Foreign results organization",
      slug: `results-foreign-${suffix}`,
    },
  });
  try {
    const user = await db.user.create({
      data: {
        organizationId: organization.id,
        email: `results-${suffix}@example.test`,
        name: "Results manager",
        passwordHash: "test-only",
        role: "MANAGER",
      },
    });
    const process = await db.process.create({
      data: {
        organizationId: organization.id,
        name: "Results processing",
        kind: "PROCESSING",
        icon: "FlaskConical",
      },
    });
    await db.deviceLayer.createMany({
      data: [
        {
          organizationId: organization.id,
          code: "TOP",
          name: "Top passivation",
          position: 0,
        },
        {
          organizationId: foreignOrganization.id,
          code: "PRIVATE",
          name: "Foreign layer",
          position: 0,
        },
      ],
    });
    const material = await db.material.create({
      data: {
        organizationId: organization.id,
        name: "Passivant",
        smiles: "private-test-structure",
      },
    });
    const equipment = await db.equipment.create({
      data: {
        organizationId: organization.id,
        processId: process.id,
        name: "Blade coater",
        nickname: "Coater 1",
      },
    });
    const experiment = await db.experiment.create({
      data: {
        organizationId: organization.id,
        createdById: user.id,
        code: `RESULTS-${suffix}`,
        title: "Results order fixture",
        steps: {
          create: [2, 0, 1].map((position) => ({
            position,
            processId: process.id,
            name: `Step ${position}`,
            layer: "TOP",
            equipmentId: equipment.id,
            materials: { create: { materialId: material.id, amount: "1 mg" } },
            parameters: {
              create: [1, 0].map((parameterPosition) => ({
                position: parameterPosition,
                name: `Variable ${parameterPosition}`,
                variations: {
                  create: {
                    variationGroup: "A",
                    value: `${position}-${parameterPosition}`,
                  },
                },
              })),
            },
          })),
        },
        samples: { create: { code: "S1", variationGroup: "A" } },
        characterizations: {
          create: { position: 0, processId: process.id, name: "J-V test" },
        },
        runs: { create: { runNo: 1, status: "CANCELLED" } },
      },
      include: { samples: true, characterizations: true, runs: true },
    });
    const characterizationId = experiment.characterizations[0].id;
    const sampleId = experiment.samples[0].id;
    await db.characterizationResult.createMany({
      data: [
        {
          characterizationId,
          sampleId,
          runId: experiment.runs[0].id,
          metrics: { PCE: "999" },
        },
        { characterizationId, sampleId, metrics: { PCE: "18.1" } },
      ],
    });
    const actor = {
      uid: user.id,
      org: organization.id,
      role: "MANAGER" as const,
    };
    const result = await getResultsExperiment(actor, experiment.id);
    expect(result?.steps.map((step) => step.position)).toEqual([0, 1, 2]);
    expect(
      result?.steps.flatMap((step) =>
        step.parameters.map((parameter) => parameter.variations[0].value),
      ),
    ).toEqual(["0-0", "0-1", "1-0", "1-1", "2-0", "2-1"]);
    expect(result?.layers).toEqual([{ code: "TOP", name: "Top passivation" }]);
    expect(result?.steps[0].equipment).toEqual({
      name: "Blade coater",
      nickname: "Coater 1",
    });
    expect(result?.steps[0].materials).toEqual([
      { amount: "1 mg", material: { name: "Passivant" } },
    ]);
    expect(JSON.stringify(result)).not.toContain("private-test-structure");
    expect(result?.characterizations[0].results).toHaveLength(1);
    expect(result?.characterizations[0].results[0]).toMatchObject({
      sampleId,
      metrics: { PCE: "18.1" },
    });
    expect(
      await getResultsExperiment(
        { ...actor, org: foreignOrganization.id },
        experiment.id,
      ),
    ).toBeNull();
  } finally {
    await db.experiment.deleteMany({
      where: { organizationId: organization.id },
    });
    await db.material.deleteMany({
      where: { organizationId: organization.id },
    });
    await db.equipment.deleteMany({
      where: { organizationId: organization.id },
    });
    await db.deviceLayer.deleteMany({
      where: {
        organizationId: { in: [organization.id, foreignOrganization.id] },
      },
    });
    await db.process.deleteMany({ where: { organizationId: organization.id } });
    await db.user.deleteMany({ where: { organizationId: organization.id } });
    await db.organization.deleteMany({
      where: { id: { in: [organization.id, foreignOrganization.id] } },
    });
  }
});
