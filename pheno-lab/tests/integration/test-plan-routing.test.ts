import { afterAll, afterEach, expect, it, vi } from "vitest";
import { db } from "@/infrastructure/db/client";
import { applyTestPlan } from "@/modules/experiments/plan-service";
import type { TestPlan, TestPlanVariable } from "@/lib/library";
import * as audit from "@/modules/audit/writer";

afterAll(() => db.$disconnect());
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const suffix = crypto.randomUUID();
  const org = await db.organization.create({
    data: { name: "DOE routing fixture", slug: `doe-${suffix}` },
  });
  const owner = await db.user.create({
    data: {
      organizationId: org.id,
      name: "DOE designer",
      email: `doe-${suffix}@example.test`,
      role: "MANAGER",
      passwordHash: "fixture-only",
    },
  });
  const process = await db.process.create({
    data: {
      organizationId: org.id,
      name: "Blade coating",
      kind: "PROCESSING",
      defaultLayer: "HTL",
      parameters: [{ name: "Speed", unit: "mm/s", defaultValue: "5" }],
    },
  });
  const equipment = await Promise.all(
    ["one", "two"].map((name) =>
      db.equipment.create({
        data: {
          organizationId: org.id,
          processId: process.id,
          name: `Coater ${name}`,
        },
      }),
    ),
  );
  const exp = await db.experiment.create({
    data: {
      organizationId: org.id,
      createdById: owner.id,
      code: `DOE-${suffix}`,
      title: "Synthetic DOE fixture",
      samples: {
        create: [
          { code: "S1", variationGroup: "A" },
          { code: "S2", variationGroup: "B" },
        ],
      },
      steps: {
        create: ["HTL", "TOP", "TOP"].map((layer, position) => ({
          processId: process.id,
          equipmentId: equipment[position === 2 ? 1 : 0].id,
          layer,
          position,
          name: `Blade ${position}`,
          notes: "Keep step context",
          parameters: {
            create: [
              {
                name: "Speed",
                unit: "mm/s",
                value: "5",
                source: "equipment",
                position: 0,
              },
              {
                name: "GAP/Speed/V",
                value: `manual-${position}`,
                source: "custom",
                position: 1,
              },
            ],
          },
        })),
      },
    },
    include: {
      samples: { orderBy: { code: "asc" } },
      steps: { orderBy: { position: "asc" } },
    },
  });
  const actor = { uid: owner.id, org: org.id, role: "MANAGER" as const };
  const variable = (
    layer: string,
    parameter: string,
    values: Record<string, string> = { A: "10", B: "20" },
  ): TestPlanVariable => ({
    kind: "parameter",
    processId: process.id,
    equipmentId: equipment[0].id,
    layer,
    parameter,
    unit: "",
    values,
  });
  const plan = (variables: TestPlanVariable[]): TestPlan => ({
    substrates: { count: 2 },
    groups: [
      { label: "A", samples: 1, isControl: false },
      { label: "B", samples: 1, isControl: true },
    ],
    assignments: { S1: "A", S2: "B" },
    variables,
  });
  const read = () =>
    db.experiment.findUniqueOrThrow({
      where: { id: exp.id },
      include: {
        samples: { orderBy: { code: "asc" } },
        steps: {
          orderBy: { position: "asc" },
          include: {
            parameters: {
              orderBy: { position: "asc" },
              include: { variations: { orderBy: { variationGroup: "asc" } } },
            },
          },
        },
      },
    });
  const cleanup = async () => {
    await db.auditEvent.deleteMany({ where: { organizationId: org.id } });
    await db.experiment.deleteMany({ where: { organizationId: org.id } });
    await db.equipment.deleteMany({ where: { organizationId: org.id } });
    await db.process.deleteMany({ where: { organizationId: org.id } });
    await db.label.deleteMany({ where: { organizationId: org.id } });
    await db.user.deleteMany({ where: { organizationId: org.id } });
    await db.organization.delete({ where: { id: org.id } });
  };
  return {
    org,
    owner,
    actor,
    process,
    equipment,
    exp,
    variable,
    plan,
    read,
    cleanup,
  };
}

it("routes repeated blade processes by machine and layer, retaining per-group values and non-first control", async () => {
  const f = await fixture();
  try {
    const original = await f.read();
    const variables = [
      f.variable("TOP", "Passivation choice", {
        A: "Material X",
        B: "Material Y",
      }),
      f.variable("TOP", "Concentration", { A: "0.1", B: "0.2" }),
      f.variable("TOP", "GAP/Speed/V", { A: "100/5/10", B: "150/6/12" }),
      f.variable("HTL", "GAP/Speed/V", { A: "80/4/8", B: "90/5/9" }),
    ];
    variables[1].unit = "mg/ml";
    await applyTestPlan(f.actor, f.exp.id, f.plan(variables));
    const result = await f.read();
    expect(
      result.steps.map((s) => [s.id, s.equipmentId, s.layer, s.notes]),
    ).toEqual(
      original.steps.map((s) => [s.id, s.equipmentId, s.layer, s.notes]),
    );
    expect(result.samples.map((s) => [s.id, s.code])).toEqual(
      original.samples.map((s) => [s.id, s.code]),
    );
    const htl = result.steps[0].parameters;
    const top = result.steps[1].parameters;
    expect(htl.find((p) => p.name === "GAP/Speed/V")).toMatchObject({
      value: "90/5/9",
      variations: [
        { variationGroup: "A", value: "80/4/8" },
        { variationGroup: "B", value: "90/5/9" },
      ],
    });
    expect(
      htl.some((p) => ["Passivation choice", "Concentration"].includes(p.name)),
    ).toBe(false);
    expect(top.find((p) => p.name === "Concentration")).toMatchObject({
      value: "0.2",
      unit: "mg/ml",
      variations: [
        { variationGroup: "A", value: "0.1" },
        { variationGroup: "B", value: "0.2" },
      ],
    });
    expect(top.find((p) => p.name === "GAP/Speed/V")?.value).toBe("150/6/12");
    expect(
      top
        .find((p) => p.name === "Passivation choice")
        ?.variations.map((v) => v.value),
    ).toEqual(["Material X", "Material Y"]);
    expect(result.steps[2]).toEqual(original.steps[2]);
    await applyTestPlan(f.actor, f.exp.id, f.plan([...variables].reverse()));
    const repeated = await f.read();
    const withoutVariationIds = (steps: typeof result.steps) =>
      steps.map((step) => ({
        ...step,
        parameters: step.parameters.map((parameter) => ({
          ...parameter,
          variations: parameter.variations.map(({ variationGroup, value }) => ({
            variationGroup,
            value,
          })),
        })),
      }));
    expect(withoutVariationIds(repeated.steps)).toEqual(
      withoutVariationIds(result.steps),
    );
    expect(repeated.samples).toEqual(result.samples);
    const row = await db.auditEvent.findFirstOrThrow({
      where: {
        organizationId: f.org.id,
        action: "experiment.test-plan.applied",
      },
    });
    expect(JSON.stringify(row.changes)).toContain('"layer":"TOP"');
  } finally {
    await f.cleanup();
  }
});

it("creates a missing scoped step once instead of relabeling another layer or machine", async () => {
  const f = await fixture();
  try {
    const before = await f.read();
    const variable = {
      ...f.variable("ETL", "Temperature"),
      equipmentId: f.equipment[1].id,
    };
    const first = await applyTestPlan(f.actor, f.exp.id, f.plan([variable]));
    expect(first.steps).toHaveLength(4);
    expect((await f.read()).steps.slice(0, 3)).toEqual(before.steps);
    expect(first.steps[3]).toMatchObject({
      layer: "ETL",
      equipmentId: f.equipment[1].id,
    });
    await applyTestPlan(f.actor, f.exp.id, f.plan([variable]));
    expect((await f.read()).steps).toHaveLength(4);
  } finally {
    await f.cleanup();
  }
});

it("fills a uniquely compatible unassigned step without changing its other settings", async () => {
  const f = await fixture();
  try {
    await db.processStep.update({
      where: { id: f.exp.steps[1].id },
      data: { equipmentId: null },
    });
    await applyTestPlan(
      f.actor,
      f.exp.id,
      f.plan([f.variable("TOP", "Speed")]),
    );
    const result = await f.read();
    expect(result.steps).toHaveLength(3);
    expect(result.steps[1]).toMatchObject({
      equipmentId: f.equipment[0].id,
      layer: "TOP",
      notes: "Keep step context",
    });
    expect(
      result.steps[1].parameters.find((p) => p.name === "Speed"),
    ).toMatchObject({ source: "equipment", value: "20" });
  } finally {
    await f.cleanup();
  }
});

it("moves and removes plan variables within their old scoped step, preserving same-named settings on another machine", async () => {
  const f = await fixture();
  try {
    const material = {
      ...f.variable("TOP", "Material slot"),
      kind: "material" as const,
    };
    await applyTestPlan(
      f.actor,
      f.exp.id,
      f.plan([f.variable("TOP", "GAP/Speed/V"), material]),
    );
    const before = await f.read();
    await applyTestPlan(
      f.actor,
      f.exp.id,
      f.plan([f.variable("HTL", "GAP/Speed/V", { A: "30", B: "40" })]),
    );
    const result = await f.read();
    expect(
      result.steps[1].parameters.find((p) => p.name === "GAP/Speed/V")
        ?.variations,
    ).toEqual([]);
    expect(
      result.steps[1].parameters.some((p) => p.name === "Material slot"),
    ).toBe(false);
    expect(
      result.steps[0].parameters.find((p) => p.name === "GAP/Speed/V")?.value,
    ).toBe("40");
    expect(result.steps[2]).toEqual(before.steps[2]);
  } finally {
    await f.cleanup();
  }
});

it("rejects ambiguous and duplicate destinations atomically, including steps provisioned earlier in the same request", async () => {
  const f = await fixture();
  try {
    const before = await f.read();
    const ambiguous = { ...f.variable("", "Speed"), equipmentId: undefined };
    await expect(
      applyTestPlan(
        f.actor,
        f.exp.id,
        f.plan([f.variable("NEW", "Temperature"), ambiguous]),
      ),
    ).rejects.toThrow("ambiguous");
    expect(await f.read()).toEqual(before);
    await expect(
      applyTestPlan(
        f.actor,
        f.exp.id,
        f.plan([f.variable("TOP", "Speed"), f.variable("TOP", "speed")]),
      ),
    ).rejects.toThrow("duplicate");
    expect(await f.read()).toEqual(before);
    expect(
      await db.auditEvent.count({ where: { organizationId: f.org.id } }),
    ).toBe(0);
  } finally {
    await f.cleanup();
  }
});

it("rolls back newly created steps, sample grouping and parameters if the plan audit fails", async () => {
  const f = await fixture();
  try {
    const before = await f.read();
    vi.spyOn(audit, "recordUserAudit").mockRejectedValue(
      new Error("Synthetic audit failure"),
    );
    const plan = f.plan([f.variable("NEW", "Temperature")]);
    plan.assignments = { S1: "B", S2: "A" };
    await expect(applyTestPlan(f.actor, f.exp.id, plan)).rejects.toThrow(
      "Synthetic audit failure",
    );
    expect(await f.read()).toEqual(before);
  } finally {
    await f.cleanup();
  }
});

it("retains organization, actor, and process/equipment ownership checks", async () => {
  const f = await fixture();
  const foreign = await fixture();
  try {
    const before = await f.read();
    const input = f.plan([f.variable("TOP", "Speed")]);
    await expect(
      applyTestPlan(foreign.actor, f.exp.id, input),
    ).rejects.toThrow();
    await expect(
      applyTestPlan({ ...f.actor, testingOnly: true }, f.exp.id, input),
    ).rejects.toThrow();
    await expect(
      applyTestPlan(
        { ...f.actor, uid: "unrelated", role: "TECHNICIAN" },
        f.exp.id,
        input,
      ),
    ).rejects.toThrow();
    await expect(
      applyTestPlan(
        f.actor,
        f.exp.id,
        f.plan([
          {
            ...f.variable("TOP", "Speed"),
            equipmentId: foreign.equipment[0].id,
          },
        ]),
      ),
    ).rejects.toThrow("Equipment");
    await expect(
      applyTestPlan(
        f.actor,
        f.exp.id,
        f.plan([foreign.variable("TOP", "Speed")]),
      ),
    ).rejects.toThrow("Process");
    expect(await f.read()).toEqual(before);
  } finally {
    await f.cleanup();
    await foreign.cleanup();
  }
});

it("serializes competing plan applications and removes only the previous committed scope", async () => {
  const f = await fixture();
  try {
    await Promise.all([
      applyTestPlan(f.actor, f.exp.id, f.plan([f.variable("TOP", "Speed")])),
      applyTestPlan(f.actor, f.exp.id, f.plan([f.variable("HTL", "Speed")])),
    ]);
    const result = await f.read();
    const saved = (result.metadata as unknown as { testPlan: TestPlan })
      .testPlan;
    const layer = saved.variables[0].layer;
    for (const step of result.steps.slice(0, 2)) {
      expect(
        step.parameters
          .find((p) => p.name === "Speed")!
          .variations.map((v) => v.value),
      ).toEqual(step.layer === layer ? ["10", "20"] : []);
    }
  } finally {
    await f.cleanup();
  }
});

it("preserves unrelated manual parameters and appends new ones after position gaps left by removed material slots", async () => {
  const f = await fixture();
  try {
    await applyTestPlan(
      f.actor,
      f.exp.id,
      f.plan([{ ...f.variable("TOP", "Material slot"), kind: "material" }]),
    );
    const manual = await db.stepParameter.create({
      data: {
        stepId: f.exp.steps[1].id,
        position: 3,
        name: "Manual setting",
        value: "keep",
        source: "custom",
      },
    });
    await applyTestPlan(
      f.actor,
      f.exp.id,
      f.plan([f.variable("TOP", "Temperature")]),
    );
    const params = (await f.read()).steps[1].parameters;
    expect(params.find((p) => p.id === manual.id)).toMatchObject({
      value: "keep",
      position: 3,
    });
    expect(params.find((p) => p.name === "Temperature")?.position).toBe(4);
    expect(new Set(params.map((p) => p.position)).size).toBe(params.length);
  } finally {
    await f.cleanup();
  }
});
