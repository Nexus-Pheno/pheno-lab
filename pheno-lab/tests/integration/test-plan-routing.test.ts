import { afterAll, afterEach, expect, it, vi } from "vitest";
import { db } from "@/infrastructure/db/client";
import { applyTestPlan } from "@/modules/experiments/plan-service";
import type { TestPlan, TestPlanVariable } from "@/lib/library";
import { TestPlanConfirmationError } from "@/modules/experiments/plan-routing";
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

async function confirmationFor(
  f: Awaited<ReturnType<typeof fixture>>,
  plan: TestPlan,
) {
  const before = await f.read();
  const auditCount = await db.auditEvent.count({
    where: { organizationId: f.org.id },
  });
  try {
    await applyTestPlan(f.actor, f.exp.id, plan);
    throw new Error("Expected overwrite confirmation");
  } catch (error) {
    if (!(error instanceof TestPlanConfirmationError)) throw error;
    expect(error.preview.changes.length).toBeGreaterThan(0);
    expect(await f.read()).toEqual(before);
    expect(
      await db.auditEvent.count({ where: { organizationId: f.org.id } }),
    ).toBe(auditCount);
    return error.preview;
  }
}
// Existing routing scenarios explicitly consent when they replace populated
// settings. Dedicated tests below exercise missing, cancelled and stale consent.
async function applyConfirmedPlan(...args: Parameters<typeof applyTestPlan>) {
  try {
    return await applyTestPlan(...args);
  } catch (error) {
    if (!(error instanceof TestPlanConfirmationError)) throw error;
    return applyTestPlan(args[0], args[1], args[2], error.preview.token);
  }
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
    await applyConfirmedPlan(f.actor, f.exp.id, f.plan(variables));
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
    await applyConfirmedPlan(
      f.actor,
      f.exp.id,
      f.plan([...variables].reverse()),
    );
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
    const first = await applyConfirmedPlan(
      f.actor,
      f.exp.id,
      f.plan([variable]),
    );
    expect(first.steps).toHaveLength(4);
    expect((await f.read()).steps.slice(0, 3)).toEqual(before.steps);
    expect(first.steps[3]).toMatchObject({
      layer: "ETL",
      equipmentId: f.equipment[1].id,
    });
    await applyConfirmedPlan(f.actor, f.exp.id, f.plan([variable]));
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
    await applyConfirmedPlan(
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
    await applyConfirmedPlan(
      f.actor,
      f.exp.id,
      f.plan([f.variable("TOP", "GAP/Speed/V"), material]),
    );
    const before = await f.read();
    await applyConfirmedPlan(
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

it("serializes competing confirmed applications and requires renewed consent for the stale one", async () => {
  const f = await fixture();
  try {
    const plans = [
      f.plan([f.variable("TOP", "Speed")]),
      f.plan([f.variable("HTL", "Speed")]),
    ];
    const previews = await Promise.all(plans.map((p) => confirmationFor(f, p)));
    const results = await Promise.allSettled(
      plans.map((p, i) =>
        applyTestPlan(f.actor, f.exp.id, p, previews[i].token),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const stale = results.find(
      (r) => r.status === "rejected",
    ) as PromiseRejectedResult;
    expect(stale.reason).toBeInstanceOf(TestPlanConfirmationError);
    expect(stale.reason.preview.token).not.toBe(previews[0].token);
    const saved = await f.read();
    const layer = (saved.metadata as unknown as { testPlan: TestPlan }).testPlan
      .variables[0].layer;
    for (const step of saved.steps.slice(0, 2))
      expect(
        step.parameters
          .find((p) => p.name === "Speed")!
          .variations.map((v) => v.value),
      ).toEqual(step.layer === layer ? ["10", "20"] : []);
  } finally {
    await f.cleanup();
  }
});

it("preserves unrelated manual parameters and appends new ones after position gaps left by removed material slots", async () => {
  const f = await fixture();
  try {
    await applyConfirmedPlan(
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
    await applyConfirmedPlan(
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

it("returns exact scoped differences without committing any changes, then applies explicit consent once", async () => {
  const f = await fixture();
  try {
    const p = f.plan([f.variable("TOP", "Speed")]);
    const preview = await confirmationFor(f, p);
    expect(preview.changes).toHaveLength(1);
    expect(preview.changes[0]).toMatchObject({
      stepName: "Blade 1",
      equipmentName: "Coater one",
      layer: "TOP",
      parameter: "Speed",
      before: { value: "5", unit: "mm/s", groups: [] },
      after: {
        value: "20",
        unit: "mm/s",
        groups: [
          { group: "A", value: "10" },
          { group: "B", value: "20" },
        ],
      },
    });
    await expect(
      applyTestPlan(f.actor, f.exp.id, p, "0".repeat(64)),
    ).rejects.toBeInstanceOf(TestPlanConfirmationError);
    await expect(applyTestPlan(f.actor, f.exp.id, p, true)).rejects.toThrow();
    await applyTestPlan(f.actor, f.exp.id, p, preview.token);
    const saved = await f.read();
    // Reapplying identical values is a no-op for overwrite consent.
    await applyTestPlan(f.actor, f.exp.id, p);
    expect((await f.read()).steps[0]).toEqual(saved.steps[0]);
    const event = await db.auditEvent.findFirstOrThrow({
      where: {
        organizationId: f.org.id,
        action: "experiment.test-plan.applied",
      },
      orderBy: { createdAt: "asc" },
    });
    expect(event.changes).toMatchObject({
      overwriteConfirmed: true,
      overwrittenParameters: 1,
    });
    expect(JSON.stringify(event.changes)).not.toContain(preview.token);
  } finally {
    await f.cleanup();
  }
});

it("refreshes stale differences after a manual edit or plan change without overwriting the new settings", async () => {
  const f = await fixture();
  try {
    const p = f.plan([f.variable("TOP", "Speed")]);
    const first = await confirmationFor(f, p);
    const param = (await f.read()).steps[1].parameters.find(
      (p) => p.name === "Speed",
    )!;
    await db.stepParameter.update({
      where: { id: param.id },
      data: { value: "manual revision" },
    });
    const before = await f.read();
    let fresh;
    try {
      await applyTestPlan(f.actor, f.exp.id, p, first.token);
      throw new Error("Expected stale consent");
    } catch (e) {
      if (!(e instanceof TestPlanConfirmationError)) throw e;
      fresh = e.preview;
    }
    expect(fresh.token).not.toBe(first.token);
    expect(fresh.changes[0].before.value).toBe("manual revision");
    expect(await f.read()).toEqual(before);
    const changed = f.plan([f.variable("TOP", "Speed", { A: "11", B: "22" })]);
    await expect(
      applyTestPlan(f.actor, f.exp.id, changed, fresh.token),
    ).rejects.toBeInstanceOf(TestPlanConfirmationError);
    await applyTestPlan(f.actor, f.exp.id, p, fresh.token);
  } finally {
    await f.cleanup();
  }
});

it("rolls back auto-created flow during confirmation and creates it once after consent", async () => {
  const f = await fixture();
  try {
    const p = f.plan([
      f.variable("NEW", "Temperature"),
      f.variable("TOP", "Speed"),
    ]);
    const preview = await confirmationFor(f, p);
    const saved = await applyTestPlan(f.actor, f.exp.id, p, preview.token);
    expect(saved.steps).toHaveLength(4);
    expect(saved.steps.find((s) => s.layer === "NEW")).toMatchObject({
      equipmentId: f.equipment[0].id,
    });
    await applyTestPlan(f.actor, f.exp.id, p);
    expect((await f.read()).steps).toHaveLength(4);
  } finally {
    await f.cleanup();
  }
});

it("binds consent to the experiment and actor and rechecks access before showing or applying differences", async () => {
  const f = await fixture();
  const other = await fixture();
  try {
    const p = f.plan([f.variable("TOP", "Speed")]);
    const preview = await confirmationFor(f, p);
    await expect(
      applyTestPlan(other.actor, f.exp.id, p, preview.token),
    ).rejects.toThrow();
    await expect(
      applyTestPlan(
        { ...f.actor, testingOnly: true },
        f.exp.id,
        p,
        preview.token,
      ),
    ).rejects.toThrow();
    const otherPlan = other.plan([other.variable("TOP", "Speed")]);
    await expect(
      applyTestPlan(other.actor, other.exp.id, otherPlan, preview.token),
    ).rejects.toBeInstanceOf(TestPlanConfirmationError);
  } finally {
    await f.cleanup();
    await other.cleanup();
  }
});

it("includes removal of old grouped values and material parameters in the confirmation", async () => {
  const f = await fixture();
  try {
    await applyConfirmedPlan(
      f.actor,
      f.exp.id,
      f.plan([
        f.variable("TOP", "Speed"),
        { ...f.variable("TOP", "Material slot"), kind: "material" },
      ]),
    );
    const empty = f.plan([]);
    const preview = await confirmationFor(f, empty);
    expect(
      preview.changes.find((c) => c.parameter === "Speed")?.after?.groups,
    ).toEqual([]);
    expect(
      preview.changes.find((c) => c.parameter === "Material slot")?.after,
    ).toBeNull();
    await applyTestPlan(f.actor, f.exp.id, empty, preview.token);
    expect(
      (await f.read()).steps[1].parameters.some(
        (p) => p.name === "Material slot",
      ),
    ).toBe(false);
  } finally {
    await f.cleanup();
  }
});

it("waits for in-flight parameter edits before checking confirmed values", async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let edited!: () => void;
  const ready = new Promise<void>((r) => {
    edited = r;
  });
  let editing: Promise<unknown> | undefined;
  let applying: Promise<unknown> | undefined;
  try {
    const plan = f.plan([f.variable("TOP", "Speed")]);
    const preview = await confirmationFor(f, plan);
    const parameter = (await f.read()).steps[1].parameters.find(
      (p) => p.name === "Speed",
    )!;
    editing = db.$transaction(async (tx) => {
      await tx.stepParameter.update({
        where: { id: parameter.id },
        data: { value: "concurrent manual" },
      });
      edited();
      await gate;
    });
    await ready;
    applying = applyTestPlan(f.actor, f.exp.id, plan, preview.token).catch(
      (error) => error,
    );
    await expect
      .poll(
        async () => {
          const rows = await db.$queryRaw<
            { query: string; wait_event_type: string | null }[]
          >`SELECT query, wait_event_type FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`;
          return rows.some(
            (r) =>
              r.wait_event_type === "Lock" &&
              r.query.includes("FOR UPDATE OF p"),
          );
        },
        { timeout: 3000 },
      )
      .toBe(true);
    release();
    await editing;
    const result = await applying;
    expect(result).toBeInstanceOf(TestPlanConfirmationError);
    expect(
      (result as TestPlanConfirmationError).preview.changes[0].before.value,
    ).toBe("concurrent manual");
    expect(
      (await f.read()).steps[1].parameters.find((p) => p.id === parameter.id)
        ?.value,
    ).toBe("concurrent manual");
  } finally {
    release();
    await editing;
    await applying;
    await f.cleanup();
  }
});

it("rolls confirmed overwrites back if their audit fails", async () => {
  const f = await fixture();
  try {
    const plan = f.plan([f.variable("TOP", "Speed")]);
    const preview = await confirmationFor(f, plan);
    const before = await f.read();
    vi.spyOn(audit, "recordUserAudit").mockRejectedValueOnce(
      new Error("Audit unavailable"),
    );
    await expect(
      applyTestPlan(f.actor, f.exp.id, plan, preview.token),
    ).rejects.toThrow("Audit unavailable");
    expect(await f.read()).toEqual(before);
    expect(
      await db.auditEvent.count({ where: { organizationId: f.org.id } }),
    ).toBe(0);
  } finally {
    await f.cleanup();
  }
});

it("shows the intended equipment and layer when confirming a compatible unassigned step", async () => {
  const f = await fixture();
  try {
    await db.processStep.update({
      where: { id: f.exp.steps[1].id },
      data: { equipmentId: null, layer: "" },
    });
    const p = f.plan([f.variable("TOP", "Speed")]);
    const preview = await confirmationFor(f, p);
    expect(preview.changes[0]).toMatchObject({
      equipmentName: "Coater one",
      layer: "TOP",
    });
    await applyTestPlan(f.actor, f.exp.id, p, preview.token);
    expect((await f.read()).steps[1]).toMatchObject({
      equipmentId: f.equipment[0].id,
      layer: "TOP",
    });
  } finally {
    await f.cleanup();
  }
});
