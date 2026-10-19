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
const password = "testing-group-browser-fixture";
const testerEmail = `testing-group-reader-${suffix}@example.test`;
const requesterNames = [
  "First submitter",
  "Colleague supplementing omitted testing instructions",
];
const photo = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=",
  "base64",
);
let organizationId = "";
let experimentId = "";
let experimentCode = "";
const requestIds: string[] = [];

test.beforeAll(async () => {
  const org = await db.organization.create({
    data: {
      name: "Testing grouping browser fixture",
      slug: `testing-group-${suffix}`,
    },
  });
  organizationId = org.id;
  const requesters = [];
  for (const [index, name] of requesterNames.entries())
    requesters.push(
      await db.user.create({
        data: {
          organizationId,
          name,
          email: `testing-group-submitter-${index}-${suffix}@example.test`,
          passwordHash: "fixture-only",
          role: "MANAGER",
        },
      }),
    );
  await db.user.create({
    data: {
      organizationId,
      name: "JV group reader",
      email: testerEmail,
      passwordHash: await bcrypt.hash(password, 4),
      testingOnly: true,
      role: "TECHNICIAN",
    },
  });
  const process = await db.process.create({
    data: { organizationId, name: "J-V", kind: "CHARACTERIZATION" },
  });
  const experiment = await db.experiment.create({
    data: {
      organizationId,
      createdById: requesters[0].id,
      code: `JV-GROUP-${suffix.slice(0, 8)}`,
      title: "PRIVATE PREPARATION GROUP FIXTURE",
      hypothesis: "PRIVATE HYPOTHESIS",
      samples: {
        create: [
          { code: "S1", simCode: "GROUP-S1" },
          { code: "S2", simCode: "GROUP-S2" },
        ],
      },
      characterizations: {
        create: {
          position: 0,
          processId: process.id,
          name: "J-V",
          notes: "Forward and reverse scans",
        },
      },
      runs: { create: [{ runNo: 1 }, { runNo: 2 }] },
    },
    include: {
      samples: { orderBy: { code: "asc" } },
      characterizations: true,
      runs: { orderBy: { runNo: "asc" } },
    },
  });
  experimentId = experiment.id;
  experimentCode = experiment.code;
  for (let index = 0; index < 2; index++) {
    const request = await db.testingRequest.create({
      data: {
        organizationId,
        experimentId,
        characterizationId: experiment.characterizations[0].id,
        runId: experiment.runs[index].id,
        requestedById: requesters[index].id,
        sampleIds: [experiment.samples[index].id],
        photoPath: `test-only-${index}.png`,
        note:
          index === 0
            ? "Original testing instructions"
            : "Additional testing instructions",
        requestKey: crypto.randomUUID(),
        createdAt: new Date(Date.UTC(2026, 0, index + 1)),
      },
    });
    requestIds.push(request.id);
  }
});

test.afterAll(async () => {
  if (organizationId) {
    await db.experiment.deleteMany({ where: { organizationId } });
    await db.process.deleteMany({ where: { organizationId } });
    await db.user.deleteMany({ where: { organizationId } });
    await db.organization.delete({ where: { id: organizationId } });
  }
  await db.$disconnect();
});

for (const view of [
  { width: 1600, height: 1000, lang: "en" },
  { width: 1600, height: 1000, lang: "zh" },
  { width: 390, height: 844, lang: "en" },
  { width: 390, height: 844, lang: "zh" },
]) {
  test(`one experiment request retains submitters and history at ${view.width}px ${view.lang}`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize(view);
    // Image rendering is a UI fixture here; the existing JV handoff suite tests
    // the real protected photo endpoint and storage authorization separately.
    await page.route("**/api/testing/photos/*", (route) =>
      route.fulfill({ contentType: "image/png", body: photo }),
    );
    await page.goto("/login");
    await page.locator("#email").fill(testerEmail);
    await page.locator("#password").fill(password);
    await page.locator('button[type="submit"]').click();
    await expect(page).toHaveURL(/\/testing$/);
    await page
      .context()
      .addCookies([
        { name: "pheno_lang", value: view.lang, url: "http://127.0.0.1:3467" },
      ]);
    await page.reload();
    const group = page.locator("[data-testing-request-experiment]");
    await expect(group).toHaveCount(1);
    await expect(group).toContainText(experimentCode);
    await expect(group).toContainText(
      view.lang === "zh" ? "需求提交人" : "Requested by",
    );
    for (const name of requesterNames) await expect(group).toContainText(name);
    await expect(group).toContainText("GROUP-S1");
    await expect(group).toContainText("GROUP-S2");
    await expect(group).toContainText(
      view.lang === "zh" ? "提交次数: 2" : "Submissions: 2",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/testing-request-list-${view.width}-${view.lang}.png`,
      fullPage: true,
    });
    await group.click();
    await expect(page).toHaveURL(
      new RegExp(`/testing/${experimentId}#request-${requestIds[1]}$`),
    );
    const detail = page.locator("[data-testing-request-experiment]");
    await expect(detail).toHaveCount(1);
    for (const name of requesterNames) await expect(detail).toContainText(name);
    await expect(detail).toContainText("Original testing instructions");
    await expect(detail).toContainText("Additional testing instructions");
    await expect(
      detail.getByRole("heading", {
        name: view.lang === "zh" ? "提交记录 · 2" : "Submission history · 2",
      }),
    ).toBeVisible();
    await expect(detail.getByRole("img")).toHaveCount(2);
    for (let index = 0; index < 2; index++) {
      const record = detail.locator(`[id="request-${requestIds[index]}"]`);
      await expect(record).toContainText(requesterNames[index]);
      await expect(record).toContainText(
        view.lang === "zh" ? `轮次 ${index + 1}` : `Run ${index + 1}`,
      );
    }
    // Old notification anchors remain valid inside the unified request card.
    await page.goto(`/testing/${experimentId}#request-${requestIds[0]}`);
    await expect(page.locator(`[id="request-${requestIds[0]}"]`)).toBeVisible();
    await expect(page.locator("main")).not.toContainText("PRIVATE PREPARATION");
    await expect(page.locator("main")).not.toContainText("PRIVATE HYPOTHESIS");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.locator("main").evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({
      path: `test-results/testing-request-detail-${view.width}-${view.lang}.png`,
      fullPage: true,
    });
    expect(errors).toEqual([]);
  });
}
