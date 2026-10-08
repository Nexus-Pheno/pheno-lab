import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { assertSafeTestDatabaseUrl } from "../../src/infrastructure/db/test-database";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is required");
assertSafeTestDatabaseUrl({
  testDatabaseUrl,
  primaryDatabaseUrl: process.env.DATABASE_URL,
  ci: process.env.CI === "true",
});
const prisma = new PrismaClient({
  datasources: { db: { url: testDatabaseUrl } },
});
const suffix = crypto.randomUUID();
const email = `usability-${suffix}@example.test`;
const password = "usability-browser-test-password";
let organizationId = "";
let authorId = "";
let processId = "";

test.beforeAll(async () => {
  const maxOrg =
    (await prisma.organization.aggregate({ _max: { orgNumber: true } }))._max
      .orgNumber ?? 0;
  const org = await prisma.organization.create({
    data: {
      name: "Usability browser test",
      slug: `usability-${suffix}`,
      orgNumber: Math.max(6000, maxOrg) + 1,
    },
  });
  organizationId = org.id;
  const author = await prisma.user.create({
    data: {
      organizationId,
      email,
      name: "Usability technician",
      role: "TECHNICIAN",
      passwordHash: await bcrypt.hash(password, 4),
    },
  });
  authorId = author.id;
  const process = await prisma.process.create({
    data: {
      organizationId,
      name: "Usability spin coating",
      kind: "PROCESSING",
      parameters: [{ name: "Spin speed", unit: "rpm", defaultValue: "1000" }],
    },
  });
  processId = process.id;
});

test.afterAll(async () => {
  if (organizationId) {
    await prisma.experiment.deleteMany({ where: { organizationId } });
    await prisma.auditEvent.deleteMany({ where: { organizationId } });
    await prisma.notification.deleteMany({ where: { organizationId } });
    await prisma.process.deleteMany({ where: { organizationId } });
    await prisma.label.deleteMany({ where: { organizationId } });
    await prisma.user.deleteMany({ where: { organizationId } });
    await prisma.organization.delete({ where: { id: organizationId } });
  }
  await prisma.$disconnect();
});

async function login(page: Page, lang: "en" | "zh") {
  await prisma.user.update({
    where: { id: authorId },
    data: { language: lang },
  });
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/$/);
}

const cases = [
  { width: 1440, height: 900, lang: "en" as const },
  { width: 1024, height: 768, lang: "zh" as const },
  { width: 390, height: 844, lang: "zh" as const },
];

for (const viewport of cases) {
  test(`empty A–E groups remain editable with 17 spare substrates (${viewport.width}, ${viewport.lang})`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await login(page, viewport.lang);
    const zh = viewport.lang === "zh";
    await page
      .getByRole("button", {
        name: zh ? "新建实验" : "New experiment",
        exact: true,
      })
      .click();
    await page
      .getByRole("button", {
        name: zh ? "正式实验" : "Real experiment",
        exact: true,
      })
      .click();
    await expect(page).toHaveURL(/\/experiments\/[^/]+$/);
    const id = new URL(page.url()).pathname.split("/").at(-1)!;
    await page
      .getByRole("button", {
        name: zh ? "定义实验方案" : "Define test plan",
        exact: true,
      })
      .click();
    const editor = page.getByTestId("test-plan-editor");
    await editor.locator('input[type="number"][max="198"]').fill("17");
    for (let i = 0; i < 3; i++) {
      await editor
        .getByRole("button", { name: zh ? "添加组" : "Add group", exact: true })
        .click();
    }
    await editor
      .locator("select")
      .filter({ has: page.locator('option[value="Spin speed"]') })
      .selectOption("Spin speed");
    for (const [i, label] of ["A", "B", "C", "D", "E"].entries()) {
      const row = editor
        .getByRole("row")
        .filter({ has: page.getByRole("cell", { name: label, exact: true }) });
      await expect(row.getByRole("spinbutton")).toHaveValue("0");
      await row.getByRole("textbox").fill(String(1000 + i * 100));
    }
    await expect(editor.getByTestId("substrate-summary")).toContainText(
      zh ? "已归组 0" : "Grouped 0",
    );
    await expect(editor.getByTestId("substrate-summary")).toContainText(
      zh ? "备用 17" : "Extras 17",
    );
    // Expand only the evidence capture so the scroll-pane screenshot contains
    // the whole plan. All interactions run at the declared test viewport.
    await page.setViewportSize({ width: 1440, height: 1800 });
    await editor.screenshot({
      path: testInfo.outputPath(
        `substrate-editor-${viewport.width}-${viewport.lang}.png`,
      ),
    });
    await page.setViewportSize(viewport);
    await editor
      .getByRole("button", {
        name: zh ? "应用实验方案" : "Apply test plan",
        exact: true,
      })
      .click();
    await expect(editor).toBeHidden();
    const samples = await prisma.sample.findMany({
      where: { experimentId: id },
      orderBy: { code: "asc" },
    });
    expect(samples).toHaveLength(17);
    expect(samples.every((sample) => sample.variationGroup === null)).toBe(
      true,
    );
    const identities = samples.map((sample) => [sample.id, sample.simCode]);
    await page.reload();
    await page.locator("[data-drop-step]").click();
    const inspector = page.locator("aside").last();
    for (const [i, label] of ["A", "B", "C", "D", "E"].entries()) {
      await expect(inspector.getByLabel(label, { exact: true })).toHaveValue(
        String(1000 + i * 100),
      );
    }
    await inspector.getByLabel("E", { exact: true }).fill("1800");
    await inspector
      .getByRole("button", {
        name: zh ? "保存更改" : "Save changes",
        exact: true,
      })
      .click();
    await expect
      .poll(async () => {
        const v = await prisma.parameterVariation.findFirst({
          where: {
            parameter: { step: { experimentId: id } },
            variationGroup: "E",
          },
        });
        return v?.value;
      })
      .toBe("1800");
    await page.reload();
    await page.locator("[data-drop-step]").click();
    await expect(
      page.locator("aside").last().getByLabel("E", { exact: true }),
    ).toHaveValue("1800");
    expect(
      (
        await prisma.sample.findMany({
          where: { experimentId: id },
          orderBy: { code: "asc" },
        })
      ).map((sample) => [sample.id, sample.simCode]),
    ).toEqual(identities);
    await page
      .locator("aside")
      .last()
      .screenshot({
        path: testInfo.outputPath(
          `group-inspector-${viewport.width}-${viewport.lang}.png`,
        ),
      });
    await page.screenshot({
      path: testInfo.outputPath(
        `empty-groups-${viewport.width}-${viewport.lang}.png`,
      ),
      fullPage: true,
    });
  });

  test(`search reaches older plans and all history pages (${viewport.width}, ${viewport.lang})`, async ({
    page,
  }, testInfo) => {
    const zh = viewport.lang === "zh";
    const marker = crypto.randomUUID().slice(0, 8);
    const sources = [];
    for (let i = 0; i < 25; i++) {
      sources.push(
        await prisma.experiment.create({
          data: {
            organizationId,
            createdById: authorId,
            code: `HISTORY-${marker}-${i}`,
            title: `History ${marker} ${i === 24 ? "older target" : i}`,
            updatedAt: new Date(Date.UTC(2026, 0, 25 - i)),
            samples: { create: [{ code: "S1", variationGroup: "A" }] },
            steps: {
              create: [{ name: "Historical process", processId, position: 0 }],
            },
          },
        }),
      );
    }
    const source = sources[24];
    await prisma.run.create({ data: { experimentId: source.id, runNo: 1 } });
    await page.setViewportSize(viewport);
    await login(page, viewport.lang);
    await page
      .getByRole("button", {
        name: zh ? "新建实验" : "New experiment",
        exact: true,
      })
      .click();
    await page
      .getByRole("button", {
        name: zh ? "从模板 / 以前的实验" : "From template / previous",
        exact: true,
      })
      .click();
    const picker = page.getByRole("dialog", {
      name: zh ? "从模板 / 以前的实验" : "From template / previous",
    });
    const search = picker.getByRole("searchbox");
    await search.fill(`HISTORY-${marker}`);
    await expect(
      picker.getByRole("button", { name: new RegExp(source.code) }),
    ).toBeHidden();
    await picker
      .getByRole("button", { name: zh ? "下一页" : "Next page", exact: true })
      .click();
    await expect(
      picker.getByRole("button", { name: new RegExp(source.code) }),
    ).toBeVisible();
    await search.fill("no-such-experiment-anywhere");
    await expect(
      picker.getByText(
        zh
          ? "没有匹配的实验编号或名称。"
          : "No experiments match this number or title.",
      ),
    ).toBeVisible();
    await search.fill(`${marker} older target`);
    const target = picker.getByRole("button", {
      name: new RegExp(source.code),
    });
    await expect(target).toBeVisible();
    await search.fill(`  ${source.code.toLowerCase()}  `);
    await expect(target).toBeVisible();
    await picker.screenshot({
      path: testInfo.outputPath(
        `history-search-${viewport.width}-${viewport.lang}.png`,
      ),
    });
    await target.click();
    await expect(page).toHaveURL(/\/experiments\/[^/]+$/);
    const copiedId = new URL(page.url()).pathname.split("/").at(-1)!;
    expect(copiedId).not.toBe(source.id);
    const copy = await prisma.experiment.findUniqueOrThrow({
      where: { id: copiedId },
      include: { samples: true, runs: true, steps: true },
    });
    expect(copy.status).toBe("DRAFT");
    expect(copy.code).not.toBe(source.code);
    expect(copy.runs).toHaveLength(0);
    expect(copy.samples).toHaveLength(1);
    expect(copy.samples[0].simCode).toBeTruthy();
    expect(copy.steps).toHaveLength(1);
    expect(await prisma.run.count({ where: { experimentId: source.id } })).toBe(
      1,
    );
  });
}
