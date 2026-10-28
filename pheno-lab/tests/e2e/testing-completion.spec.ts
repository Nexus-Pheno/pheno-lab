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
const email = `completion-browser-${suffix}@example.test`;
const password = "completion-browser-fixture";
let organizationId = "";
let experimentId = "";
let sampleId = "";
let runId = "";
let characterizationId = "";

test.beforeAll(async () => {
  const org = await db.organization.create({
    data: { name: "Completion browser", slug: `completion-browser-${suffix}` },
  });
  organizationId = org.id;
  const author = await db.user.create({
    data: {
      organizationId,
      name: "Preparation submitter",
      email: `author-${email}`,
      passwordHash: await bcrypt.hash(password, 4),
      role: "MANAGER",
    },
  });
  await db.user.create({
    data: {
      organizationId,
      name: "Completion testing reader",
      email,
      passwordHash: await bcrypt.hash(password, 4),
      role: "TECHNICIAN",
      testingOnly: true,
    },
  });
  const process = await db.process.create({
    data: { organizationId, name: "JV", kind: "CHARACTERIZATION" },
  });
  const experiment = await db.experiment.create({
    data: {
      organizationId,
      createdById: author.id,
      code: `JV-COMPLETE-${suffix.slice(0, 8)}`,
      title: "PRIVATE COMPLETION PREPARATION",
      samples: {
        create: [
          { code: "S1", variationGroup: "A" },
          { code: "S2", variationGroup: "B" },
          { code: "S3", variationGroup: "ERROR" },
          { code: "S4" },
        ],
      },
      runs: { create: { runNo: 1 } },
      characterizations: {
        create: { name: "J-V", processId: process.id, position: 0 },
      },
    },
    include: {
      samples: { orderBy: { code: "asc" } },
      runs: true,
      characterizations: true,
    },
  });
  experimentId = experiment.id;
  sampleId = experiment.samples[1].id;
  runId = experiment.runs[0].id;
  characterizationId = experiment.characterizations[0].id;
  await db.notification.create({
    data: {
      organizationId,
      userId: author.id,
      kind: "testing_completed",
      actorName: "",
      entityLabel: experiment.code,
      href: `/experiments/${experimentId}/results`,
    },
  });
  await db.testingRequest.create({
    data: {
      organizationId,
      experimentId,
      runId,
      characterizationId,
      requestedById: author.id,
      sampleIds: experiment.samples.map((s) => s.id),
      photoPath: "fixture-only.png",
      requestKey: crypto.randomUUID(),
    },
  });
  await db.characterizationResult.create({
    data: {
      characterizationId,
      runId,
      sampleId: experiment.samples[0].id,
      metrics: { "PCE (%)": "20" },
    },
  });
});
test.afterAll(async () => {
  if (organizationId) {
    await db.auditEvent.deleteMany({ where: { organizationId } });
    await db.experiment.deleteMany({ where: { organizationId } });
    await db.process.deleteMany({ where: { organizationId } });
    await db.user.deleteMany({ where: { organizationId } });
    await db.organization.delete({ where: { id: organizationId } });
  }
  await db.$disconnect();
});

for (const view of [
  { width: 1600, height: 1000, lang: "zh" },
  { width: 1600, height: 1000, lang: "en" },
  { width: 390, height: 844, lang: "zh" },
  { width: 390, height: 844, lang: "en" },
]) {
  test(`completed request is green, accessible and refreshes at ${view.width}px ${view.lang}`, async ({
    page,
  }) => {
    await db.characterizationResult.deleteMany({
      where: { sampleId, runId, characterizationId },
    });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setViewportSize(view);
    await page.route("**/api/testing/photos/*", (r) =>
      r.fulfill({
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=",
          "base64",
        ),
      }),
    );
    await page.goto("/login");
    await page.locator("#email").fill(email);
    await page.locator("#password").fill(password);
    await page.locator('button[type="submit"]').click();
    await expect(page).toHaveURL(/\/testing$/);
    await page
      .context()
      .addCookies([
        { name: "pheno_lang", value: view.lang, url: "http://127.0.0.1:3467" },
      ]);
    await page.reload();
    const request = page.locator("[data-testing-request-experiment]");
    const pending = view.lang === "zh" ? "测试中" : "Testing in progress";
    const complete = view.lang === "zh" ? "已完成测试" : "Testing completed";
    await expect(request.locator('[data-testing-complete="false"]')).toHaveText(
      pending,
    );
    await db.characterizationResult.create({
      data: {
        sampleId,
        runId,
        characterizationId,
        metrics: { "PCE (%)": "21" },
      },
    });
    await page
      .getByRole("button", {
        name: view.lang === "zh" ? "刷新" : "Refresh",
        exact: true,
      })
      .click();
    await expect(
      request.locator('[data-testing-complete="true"]'),
    ).toContainText(complete);
    await expect(request).toHaveClass(/bg-emerald-50/);
    await expect(page.locator("main")).not.toContainText(
      view.lang === "zh" ? "等待 JV 数据更新" : "Waiting for JV data",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/testing-completed-list-${view.width}-${view.lang}.png`,
      fullPage: true,
    });
    await request.click();
    await expect(
      page.locator(
        '[data-testing-request-experiment] [data-testing-complete="true"]',
      ),
    ).toHaveCount(2);
    await expect(page.locator("main")).not.toContainText("PRIVATE COMPLETION");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/testing-completed-detail-${view.width}-${view.lang}.png`,
      fullPage: true,
    });
    await db.characterizationResult.deleteMany({
      where: { sampleId, runId, characterizationId },
    });
    await page
      .getByRole("button", {
        name: view.lang === "zh" ? "刷新" : "Refresh",
        exact: true,
      })
      .click();
    await expect(
      page.locator(
        '[data-testing-request-experiment] [data-testing-complete="false"]',
      ),
    ).toHaveCount(2);
    expect(errors).toEqual([]);
  });
}

for (const lang of ["zh", "en"]) {
  test(`completion notification opens authorized results in ${lang}`, async ({
    page,
  }) => {
    await page.goto("/login");
    await page.locator("#email").fill(`author-${email}`);
    await page.locator("#password").fill(password);
    await page.locator('button[type="submit"]').click();
    await expect(page).not.toHaveURL(/\/login$/);
    await page
      .context()
      .addCookies([
        { name: "pheno_lang", value: lang, url: "http://127.0.0.1:3467" },
      ]);
    await page.goto("/dashboard");
    await page
      .getByRole("button", {
        name: lang === "zh" ? "通知" : "Notifications",
        exact: true,
      })
      .click();
    const link = page.getByRole("link", {
      name: new RegExp(lang === "zh" ? "已完成测试" : "Testing completed"),
    });
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAttribute(
      "href",
      `/experiments/${experimentId}/results`,
    );
    await link.click();
    await expect(page).toHaveURL(
      new RegExp(`/experiments/${experimentId}/results$`),
    );
  });
}

for (const view of [
  { width: 1600, height: 1000, lang: "zh" },
  { width: 1600, height: 1000, lang: "en" },
  { width: 390, height: 844, lang: "zh" },
  { width: 390, height: 844, lang: "en" },
]) {
  test(`specialist corrects status with a reason and restores automatic status at ${view.width}px ${view.lang}`, async ({
    page,
  }) => {
    await db.testingStatusOverride.deleteMany({ where: { experimentId } });
    await db.characterizationResult.deleteMany({
      where: { sampleId, runId, characterizationId },
    });
    await page.setViewportSize(view);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/testing/photos/*", (route) =>
      route.fulfill({
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=",
          "base64",
        ),
      }),
    );
    await page.goto("/login");
    await page.locator("#email").fill(email);
    await page.locator("#password").fill(password);
    await page.locator('button[type="submit"]').click();
    await expect(page).toHaveURL(/\/testing$/);
    await page
      .context()
      .addCookies([
        { name: "pheno_lang", value: view.lang, url: "http://127.0.0.1:3467" },
      ]);
    await page.reload();
    const zh = view.lang === "zh";
    const listEditor = page.locator("[data-testing-status-editor]");
    await listEditor.locator("summary").click();
    const completeButton = listEditor.getByRole("button", {
      name: zh ? "标记已完成" : "Mark completed",
      exact: true,
    });
    const reason = listEditor.getByRole("textbox", {
      name: zh ? "修正原因" : "Reason for correction",
    });
    await completeButton.click();
    expect(
      await reason.evaluate(
        (element: HTMLTextAreaElement) => element.validity.valueMissing,
      ),
    ).toBe(true);
    await reason.fill("   ");
    await completeButton.click();
    await expect(listEditor.getByRole("alert")).toContainText(
      zh ? "请填写" : "Enter a reason",
    );
    await reason.fill("Instrument finished; status verified by specialist.");
    await completeButton.click();
    await expect(listEditor.getByRole("status")).toContainText(
      zh ? "需求状态已更新" : "Request status updated",
    );
    const request = page.locator("[data-testing-request-experiment]");
    await expect(request.locator('[data-testing-complete="true"]')).toHaveCount(
      1,
    );
    await expect(
      request.locator('[data-testing-status-source="MANUAL"]'),
    ).toContainText("Instrument finished");
    await page.reload();
    await expect(
      request.locator('[data-testing-status-source="MANUAL"]'),
    ).toHaveCount(1);
    await request.click();
    const detail = page.locator("[data-testing-request-experiment]");
    await expect(detail.locator('[data-testing-complete="true"]')).toHaveCount(
      1,
    );
    await expect(detail.locator('[data-testing-complete="false"]')).toHaveCount(
      1,
    );
    const editor = page.locator("[data-testing-status-editor]");
    await editor.locator("summary").click();
    await editor.getByRole("textbox").fill("Retest required.");
    await editor
      .getByRole("button", {
        name: zh ? "标记测试中" : "Mark in progress",
        exact: true,
      })
      .click();
    await expect(detail.locator('[data-testing-complete="false"]')).toHaveCount(
      2,
    );
    await expect(
      detail.locator('[data-testing-status-source="MANUAL"]'),
    ).toContainText("Retest required");
    await page.screenshot({
      path: `test-results/testing-status-manual-${view.width}-${view.lang}.png`,
      fullPage: true,
    });
    await editor
      .getByRole("textbox")
      .fill("Use instrument data to determine current progress.");
    await editor
      .getByRole("button", {
        name: zh ? "恢复自动判断" : "Restore automatic status",
        exact: true,
      })
      .click();
    await expect(
      detail.locator('[data-testing-status-source="AUTO"]'),
    ).toHaveCount(1);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(page.locator("main")).not.toContainText("PRIVATE COMPLETION");
    expect(errors).toEqual([]);
  });
}

test("ordinary preparation users cannot see the status editor", async ({
  page,
}) => {
  await page.goto("/login");
  await page.locator("#email").fill(`author-${email}`);
  await page.locator("#password").fill(password);
  await page.locator('button[type="submit"]').click();
  await expect(page).not.toHaveURL(/\/login$/);
  await page.goto(`/testing/${experimentId}`);
  await expect(page.locator("[data-testing-request-experiment]")).toHaveCount(
    1,
  );
  await expect(page.locator("[data-testing-status-editor]")).toHaveCount(0);
});

test("a stale browser cannot mark a newly submitted request batch complete", async ({
  page,
}) => {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/testing$/);
  await page
    .context()
    .addCookies([
      { name: "pheno_lang", value: "en", url: "http://127.0.0.1:3467" },
    ]);
  await page.reload();
  const editor = page.locator("[data-testing-status-editor]");
  await editor.locator("summary").click();
  await editor.getByRole("textbox").fill("Old batch finished.");
  const first = await db.testingRequest.findFirstOrThrow({
    where: { experimentId },
  });
  await db.testingRequest.create({
    data: {
      organizationId,
      experimentId,
      runId,
      characterizationId,
      requestedById: first.requestedById,
      sampleIds: first.sampleIds,
      photoPath: "fixture-new-submission.png",
      requestKey: crypto.randomUUID(),
    },
  });
  await editor
    .getByRole("button", { name: "Mark completed", exact: true })
    .click();
  await expect(editor.getByRole("alert")).toContainText(
    "New requests have arrived",
  );
  await page.reload();
  const request = page.locator("[data-testing-request-experiment]");
  await expect(request.locator('[data-testing-complete="false"]')).toHaveCount(
    1,
  );
  await expect(
    request.locator('[data-testing-status-source="AUTO"]'),
  ).toHaveCount(1);
});
