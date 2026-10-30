import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { assertSafeTestDatabaseUrl } from "../../src/infrastructure/db/test-database";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL required");
assertSafeTestDatabaseUrl({
  testDatabaseUrl: url,
  primaryDatabaseUrl: process.env.DATABASE_URL,
  ci: process.env.CI === "true",
});
const db = new PrismaClient({ datasources: { db: { url } } });
const suffix = crypto.randomUUID();
const email = `doe-browser-${suffix}@example.test`;
const password = "synthetic-doe-browser-password";
let organizationId = "",
  userId = "",
  processId = "",
  equipmentId = "";

test.beforeAll(async () => {
  const max =
    (await db.organization.aggregate({ _max: { orgNumber: true } }))._max
      .orgNumber ?? 0;
  const org = await db.organization.create({
    data: {
      name: "DOE browser",
      slug: `doe-browser-${suffix}`,
      orgNumber: Math.max(7000, max) + 1,
    },
  });
  organizationId = org.id;
  const user = await db.user.create({
    data: {
      organizationId,
      email,
      name: "DOE fixture designer",
      role: "MANAGER",
      passwordHash: await bcrypt.hash(password, 4),
    },
  });
  userId = user.id;
  const process = await db.process.create({
    data: {
      organizationId,
      name: "Blade coating fixture",
      kind: "PROCESSING",
      parameters: ["Passivation choice", "Concentration", "GAP/Speed/V"].map(
        (name) => ({ name, unit: "", defaultValue: "" }),
      ),
    },
  });
  processId = process.id;
  const equipment = await db.equipment.create({
    data: { organizationId, processId, name: "Fixture coater" },
  });
  equipmentId = equipment.id;
  await db.deviceLayer.createMany({
    data: [
      { organizationId, code: "HTL", name: "HTL", position: 0 },
      { organizationId, code: "TOP", name: "Top passivation", position: 1 },
    ],
  });
});
test.afterAll(async () => {
  await db.auditEvent.deleteMany({ where: { organizationId } });
  await db.experiment.deleteMany({ where: { organizationId } });
  await db.equipment.deleteMany({ where: { organizationId } });
  await db.process.deleteMany({ where: { organizationId } });
  await db.deviceLayer.deleteMany({ where: { organizationId } });
  await db.label.deleteMany({ where: { organizationId } });
  await db.user.deleteMany({ where: { organizationId } });
  await db.organization.delete({ where: { id: organizationId } });
  await db.$disconnect();
});

for (const view of [
  { width: 1600, height: 1000, lang: "en" },
  { width: 1600, height: 1000, lang: "zh" },
  { width: 390, height: 844, lang: "en" },
  { width: 390, height: 844, lang: "zh" },
]) {
  test(`plan applies to the corresponding blade layer at ${view.width}px ${view.lang}`, async ({
    page,
  }) => {
    const variables = [
      {
        layer: "TOP",
        parameter: "Passivation choice",
        values: { A: "Material X", B: "Material Y" },
      },
      {
        layer: "TOP",
        parameter: "Concentration",
        values: { A: "0.1", B: "0.2" },
      },
      {
        layer: "TOP",
        parameter: "GAP/Speed/V",
        values: { A: "100/5/10", B: "150/6/12" },
      },
      {
        layer: "HTL",
        parameter: "GAP/Speed/V",
        values: { A: "80/4/8", B: "90/5/9" },
      },
    ].map((v) => ({
      ...v,
      processId,
      equipmentId,
      kind: "parameter",
      unit: v.parameter === "Concentration" ? "mg/ml" : "",
    }));
    const experiment = await db.experiment.create({
      data: {
        organizationId,
        createdById: userId,
        code: `DOE-UI-${crypto.randomUUID()}`,
        title: "DOE browser fixture",
        metadata: {
          testPlan: {
            substrates: { count: 2 },
            groups: [
              { label: "A", samples: 1, isControl: true },
              { label: "B", samples: 1, isControl: false },
            ],
            assignments: { S1: "A", S2: "B" },
            variables,
          },
        },
        samples: {
          create: [
            { code: "S1", variationGroup: "A" },
            { code: "S2", variationGroup: "B" },
          ],
        },
        steps: {
          create: ["HTL", "TOP"].map((layer, position) => ({
            processId,
            equipmentId,
            layer,
            position,
            name: `Blade ${layer}`,
            parameters: {
              create: {
                position: 0,
                name: "GAP/Speed/V",
                value: "original",
                source: "custom",
              },
            },
          })),
        },
      },
      include: {
        steps: { orderBy: { position: "asc" } },
        samples: { orderBy: { code: "asc" } },
      },
    });
    await page.setViewportSize(view);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/login");
    await page.locator("#email").fill(email);
    await page.locator("#password").fill(password);
    await page.locator('button[type="submit"]').click();
    await expect(page).toHaveURL(/\/$/);
    await page
      .context()
      .addCookies([
        { name: "pheno_lang", value: view.lang, url: "http://127.0.0.1:3467" },
      ]);
    await page.goto(`/experiments/${experiment.id}`);
    const zh = view.lang === "zh";
    await page
      .getByRole("button", {
        name: zh ? "编辑实验方案" : "Edit test plan",
        exact: true,
      })
      .click();
    const editor = page.getByTestId("test-plan-editor");
    const layerSelects = editor
      .locator("select")
      .filter({ has: page.locator('option[value="TOP"]') });
    expect(
      await layerSelects.evaluateAll((elements) =>
        elements.map((el) => (el as HTMLSelectElement).value),
      ),
    ).toEqual(["TOP", "TOP", "TOP", "HTL"]);
    await editor
      .getByRole("row")
      .filter({ has: page.getByRole("cell", { name: "B", exact: true }) })
      .getByRole("textbox")
      .nth(1)
      .fill("0.3");
    await editor
      .getByRole("button", {
        name: zh ? "应用实验方案" : "Apply test plan",
        exact: true,
      })
      .click();
    await expect(editor).toBeHidden();
    await expect(
      page.locator(`[data-drop-step="${experiment.steps[0].id}"]`),
    ).not.toContainText("Passivation choice");
    await expect(
      page.locator(`[data-drop-step="${experiment.steps[1].id}"]`),
    ).toContainText("Concentration");
    const read = () =>
      db.processStep.findMany({
        where: { experimentId: experiment.id },
        orderBy: { position: "asc" },
        include: {
          parameters: {
            include: { variations: { orderBy: { variationGroup: "asc" } } },
          },
        },
      });
    const steps = await read();
    expect(steps.map((s) => [s.id, s.layer, s.equipmentId])).toEqual(
      experiment.steps.map((s) => [s.id, s.layer, s.equipmentId]),
    );
    expect(steps[0].parameters).toHaveLength(1);
    expect(steps[0].parameters[0].variations.map((v) => v.value)).toEqual([
      "80/4/8",
      "90/5/9",
    ]);
    expect(
      steps[1].parameters
        .find((p) => p.name === "Concentration")
        ?.variations.map((v) => v.value),
    ).toEqual(["0.1", "0.3"]);
    await page.reload();
    await page.locator(`[data-drop-step="${experiment.steps[1].id}"]`).click();
    await expect
      .poll(() =>
        page
          .locator("aside")
          .last()
          .getByRole("textbox")
          .evaluateAll((elements) =>
            elements.map((element) => (element as HTMLInputElement).value),
          ),
      )
      .toContain("Concentration");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/doe-routing-${view.width}-${view.lang}.png`,
    });

    // Introduce an exact duplicate scope: the application must reject it,
    // retain the draft and leave the persisted experiment unchanged.
    await db.processStep.create({
      data: {
        experimentId: experiment.id,
        processId,
        equipmentId,
        layer: "TOP",
        position: 2,
        name: "Second top step",
      },
    });
    await page.reload();
    await page
      .getByRole("button", {
        name: zh ? "编辑实验方案" : "Edit test plan",
        exact: true,
      })
      .click();
    const before = await read();
    await editor
      .getByRole("button", {
        name: zh ? "应用实验方案" : "Apply test plan",
        exact: true,
      })
      .click();
    await expect(editor.getByRole("alert")).toContainText(
      zh ? "匹配到多个工序" : "Several steps match",
    );
    await expect(editor).toBeVisible();
    await expect(
      editor.getByRole("button", {
        name: zh ? "应用实验方案" : "Apply test plan",
        exact: true,
      }),
    ).toBeEnabled();
    expect(await read()).toEqual(before);
    expect(errors).toEqual([]);
  });
}
