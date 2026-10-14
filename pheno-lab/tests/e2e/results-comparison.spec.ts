import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { E2E_MANAGER_EMAIL, E2E_PASSWORD } from "./global-setup";

const groups = Array.from(
  { length: 16 },
  (_, index) => `G${String(index + 1).padStart(2, "0")}`,
);
const steps = [
  "Cleaning",
  "Surface treatment",
  "HTL coating",
  "PVK coating",
  "Evaporation",
  "ALD",
];
let prisma: PrismaClient;
let experimentId: string;
let processId: string;

test.beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL)
    throw new Error("TEST_DATABASE_URL is required");
  prisma = new PrismaClient({
    datasources: { db: { url: process.env.TEST_DATABASE_URL } },
  });
  const organization = await prisma.organization.findUniqueOrThrow({
    where: { slug: "e2e-org" },
  });
  const manager = await prisma.user.findUniqueOrThrow({
    where: { email: E2E_MANAGER_EMAIL },
  });
  const suffix = crypto.randomUUID();
  const testProcess = await prisma.process.create({
    data: {
      organizationId: organization.id,
      name: `Results fixture ${suffix}`,
      kind: "PROCESSING",
      icon: "FlaskConical",
    },
  });
  processId = testProcess.id;
  const experiment = await prisma.experiment.create({
    data: {
      organizationId: organization.id,
      createdById: manager.id,
      code: `E2E-RESULTS-${suffix.slice(0, 8)}`,
      title: "Results comparison fixture",
      metadata: {
        testPlan: {
          groups: [...groups, "G17"].map((label, index) => ({
            label,
            isControl: index === 0,
          })),
        },
      },
      steps: {
        create: [5, 3, 0, 4, 2, 1].map((position) => ({
          position,
          processId,
          name: steps[position],
          parameters: {
            create: [1, 0].map((parameterPosition) => ({
              position: parameterPosition,
              name: `Variable ${position + 1}.${parameterPosition + 1}`,
              unit: parameterPosition === 0 ? "min" : "",
              variations: {
                create: groups.map((group, groupIndex) => ({
                  variationGroup: group,
                  value: `condition-${position + 1}-${parameterPosition + 1}-${groupIndex + 1}`,
                })),
              },
            })),
          },
        })),
      },
      samples: {
        create: [
          ...groups.flatMap((group, groupIndex) =>
            [0, 1].map((index) => ({
              code: `S${groupIndex * 2 + index + 1}`,
              simCode: `E2E-S${groupIndex * 2 + index + 1}`,
              variationGroup: group,
            })),
          ),
          { code: "S99", variationGroup: "ERROR" },
        ],
      },
      characterizations: {
        create: { position: 0, processId, name: "J-V fixture" },
      },
      runs: { create: { runNo: 1, status: "CANCELLED" } },
    },
    include: { samples: true, characterizations: true, runs: true },
  });
  experimentId = experiment.id;
  const characterizationId = experiment.characterizations[0].id;
  await prisma.characterizationResult.createMany({
    data: [
      {
        characterizationId,
        sampleId: experiment.samples.find((sample) => sample.code === "S1")!.id,
        runId: experiment.runs[0].id,
        metrics: { PCE: "999" },
      },
      ...experiment.samples.toReversed().map((sample) => {
        const index = Number(sample.code.slice(1));
        return {
          characterizationId,
          sampleId: sample.id,
          metrics: {
            PCE: (18 + index / 10).toFixed(1),
            FF: (70 + index / 10).toFixed(1),
          },
        };
      }),
    ],
  });
});

test.afterAll(async () => {
  if (experimentId)
    await prisma.experiment.delete({ where: { id: experimentId } });
  if (processId) await prisma.process.delete({ where: { id: processId } });
  await prisma?.$disconnect();
});

for (const viewport of [
  { width: 1600, height: 1000, lang: "en" },
  { width: 768, height: 1024, lang: "zh" },
  { width: 390, height: 844, lang: "en" },
  { width: 390, height: 844, lang: "zh" },
]) {
  test(`results link variables and measurements in workflow order at ${viewport.width}px ${viewport.lang}`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize(viewport);
    await page.goto("/login");
    await page.locator("#email").fill(E2E_MANAGER_EMAIL);
    await page.locator("#password").fill(E2E_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await expect(page).toHaveURL(/\/$/);
    await page.context().addCookies([
      {
        name: "pheno_lang",
        value: viewport.lang,
        domain: "127.0.0.1",
        path: "/",
      },
    ]);
    await page.goto(`/experiments/${experimentId}/results`);
    const comparison = page.locator("[data-result-comparison]");
    await expect(comparison).toHaveCount(1);
    await expect(comparison.locator("th").first()).toHaveText(
      viewport.lang === "zh" ? "基片 ID" : "Substrate ID",
    );
    const headers = await comparison
      .locator("thead [data-result-variable]")
      .allTextContents();
    expect(headers).toHaveLength(12);
    headers.forEach((header, index) =>
      expect(header).toContain(
        `Variable ${Math.floor(index / 2) + 1}.${(index % 2) + 1}`,
      ),
    );
    const firstRow = comparison.locator('[data-result-sample="S1"]');
    await expect(firstRow).toContainText("E2E-S1");
    await expect(firstRow).toContainText("condition-1-1-1");
    await expect(firstRow).toContainText("18.1");
    const lastRow = comparison.locator('[data-result-sample="S32"]');
    await expect(lastRow).toContainText("condition-6-2-16");
    await expect(lastRow).toContainText("21.2");
    await expect(comparison.locator("[data-result-sample]")).toHaveCount(32);
    await expect(
      comparison.locator('[data-result-group="G17"][data-empty-group="true"]'),
    ).toHaveCount(1);
    await expect(comparison).not.toContainText("999");
    await expect(page.getByText("ERROR", { exact: true })).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/results-table-${viewport.width}-${viewport.lang}.png`,
    });
    const tableScroll = comparison.locator("[data-horizontal-scroll]");
    await tableScroll.evaluate((element) =>
      element.scrollIntoView({ block: "start" }),
    );
    const rect = (await tableScroll.boundingBox())!;
    const stickyBefore = (await comparison
      .locator("th")
      .first()
      .boundingBox())!;
    await page.mouse.move(rect.x + Math.min(rect.width - 15, 250), rect.y + 12);
    await page.mouse.down();
    await page.mouse.move(
      rect.x + Math.min(rect.width - 15, 250) - 130,
      rect.y + 12,
      { steps: 5 },
    );
    await page.mouse.up();
    await expect
      .poll(() => tableScroll.evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(100);
    const stickyAfter = (await comparison.locator("th").first().boundingBox())!;
    expect(Math.abs(stickyAfter.x - stickyBefore.x)).toBeLessThan(2);
    await tableScroll.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    const meanLabel = (await comparison
      .getByText(viewport.lang === "zh" ? "G01 平均" : "G01 mean", {
        exact: true,
      })
      .boundingBox())!;
    expect(meanLabel.x).toBeGreaterThanOrEqual(rect.x);
    expect(meanLabel.x + meanLabel.width).toBeLessThan(rect.x + rect.width);
    await page.screenshot({
      path: `test-results/results-metrics-${viewport.width}-${viewport.lang}.png`,
    });
    const chart = page.getByRole("img", { name: "PCE", exact: true });
    await chart.scrollIntoViewIfNeeded();
    const chartScroll = chart.locator("..");
    if (viewport.width === 1600) {
      expect(
        await chartScroll.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
    } else {
      await chartScroll.focus();
      await page.keyboard.press("ArrowRight");
      await expect
        .poll(() => chartScroll.evaluate((element) => element.scrollLeft))
        .toBeGreaterThan(0);
    }
    await page.screenshot({
      path: `test-results/results-${viewport.width}-${viewport.lang}.png`,
    });
    expect(errors).toEqual([]);
  });
}
