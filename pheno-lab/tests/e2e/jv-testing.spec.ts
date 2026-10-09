import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { encryptCredentialWithKey } from "../../src/infrastructure/crypto/credential";
import { assertSafeTestDatabaseUrl } from "../../src/infrastructure/db/test-database";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL required");
assertSafeTestDatabaseUrl({
  testDatabaseUrl,
  primaryDatabaseUrl: process.env.DATABASE_URL,
  ci: process.env.CI === "true",
});
const db = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
const suffix = crypto.randomUUID();
const managerEmail = `jv-manager-${suffix}@example.test`;
const testerEmail = `jv-tester-${suffix}@example.test`;
const managerPassword = "jv-browser-password-only";
const temporaryPassword = "jv-temporary-password-only";
const newPassword = "jv-new-personal-password-only";
let organizationId = "";
let experimentId = "";
let experimentCode = "";
let testerId = "";
let handoffId = "";
const image = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=",
  "base64",
);

test.beforeAll(async () => {
  const org = await db.organization.create({
    data: { name: "JV browser fixture", slug: `jv-browser-${suffix}` },
  });
  organizationId = org.id;
  const manager = await db.user.create({
    data: {
      organizationId,
      name: "JV Manager",
      email: managerEmail,
      passwordHash: await bcrypt.hash(managerPassword, 4),
      role: "MANAGER",
      memberAdmin: true,
    },
  });
  const tester = await db.user.create({
    data: {
      organizationId,
      name: "JV Specialist",
      email: testerEmail,
      passwordHash: await bcrypt.hash(temporaryPassword, 4),
      role: "TECHNICIAN",
      testingOnly: true,
      mustChangePassword: true,
      temporaryPasswordExpiresAt: new Date(Date.now() + 3600_000),
    },
  });
  testerId = tester.id;
  const handoff = await db.accountHandoff.create({
    data: {
      organizationId,
      targetUserId: testerId,
      recipientIds: [manager.id],
      encryptedPassword: encryptCredentialWithKey(
        temporaryPassword,
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      ),
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  handoffId = handoff.id;
  await db.notification.create({
    data: {
      organizationId,
      userId: manager.id,
      kind: "account_setup_ready",
      actorName: "Pheno Lab",
      entityLabel: tester.name,
      href: `/account-handoffs/${handoffId}`,
    },
  });
  const process = await db.process.create({
    data: { organizationId, name: "J-V", kind: "CHARACTERIZATION" },
  });
  const exp = await db.experiment.create({
    data: {
      organizationId,
      createdById: manager.id,
      title: "PRIVATE PREPARATION BROWSER TITLE",
      hypothesis: "PRIVATE HYPOTHESIS",
      code: `JV-BROWSER-${suffix}`,
      status: "IN_LAB",
      samples: {
        create: [
          { code: "S1", simCode: "90A01" },
          { code: "S2", simCode: "90A02" },
        ],
      },
      characterizations: {
        create: {
          name: "J-V",
          processId: process.id,
          position: 0,
          notes: "Forward and reverse scans",
        },
      },
      runs: { create: { runNo: 1, status: "IN_PROGRESS" } },
    },
  });
  experimentId = exp.id;
  experimentCode = exp.code;
});

test.afterAll(async () => {
  if (organizationId) {
    const where = { organizationId };
    await db.notification.deleteMany({ where });
    await db.accountHandoff.deleteMany({ where });
    await db.auditEvent.deleteMany({ where });
    await db.experiment.deleteMany({ where });
    await db.process.deleteMany({ where });
    await db.user.deleteMany({ where });
    await db.organization.delete({ where: { id: organizationId } });
  }
  await db.$disconnect();
});

async function login(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.locator('button[type="submit"]').click();
}

test("private notification handoff and mandatory setup prevent general app access", async ({
  page,
  browser,
}) => {
  await login(page, managerEmail, managerPassword);
  await expect(page).toHaveURL(/\/$/);
  await page
    .getByRole("button", { name: "Notifications", exact: true })
    .click();
  await page
    .getByRole("link")
    .filter({ hasText: "prepared a private account login" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Private account setup" }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Temporary password", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Show temporary password" }).click();
  await expect(
    page.getByLabel("Temporary password", { exact: true }),
  ).toHaveValue(temporaryPassword);
  await page.context().clearCookies();
  await login(page, testerEmail, temporaryPassword);
  await expect(page).toHaveURL(/\/account\/setup$/);
  await expect(
    page.getByRole("heading", { name: "Set your own password" }),
  ).toBeVisible();
  await page.goto(`/experiments/${experimentId}`);
  await expect(page).toHaveURL(/\/account\/setup$/);
  expect(await page.locator("body").innerText()).not.toContain(
    "PRIVATE PREPARATION",
  );
  const oldCookies = await page.context().cookies();
  await page.locator('input[name="current"]').fill(temporaryPassword);
  await page.locator('input[name="next"]').fill(newPassword);
  await page.locator('input[name="confirm"]').fill(newPassword);
  await page
    .getByRole("button", { name: "Save password and continue" })
    .click();
  await expect(page).toHaveURL(/\/testing$/);
  await expect(
    page.getByRole("heading", { name: "JV testing", exact: true }),
  ).toBeVisible();
  const stale = await browser.newContext();
  await stale.addCookies(oldCookies);
  const stalePage = await stale.newPage();
  await stalePage.goto("/testing");
  await expect(stalePage).toHaveURL(/\/login$/);
  await stale.close();
  for (const path of [
    "/",
    "/portal",
    "/library",
    "/data",
    "/profile",
    "/analysis",
    "/instruments",
    `/experiments/${experimentId}`,
  ]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/testing$/);
    expect(await page.locator("body").innerText()).not.toMatch(
      /PRIVATE PREPARATION|PRIVATE HYPOTHESIS/,
    );
  }
  expect(
    (
      await page.request.post("/api/upload", {
        multipart: {
          file: { name: "denied.png", mimeType: "image/png", buffer: image },
        },
      })
    ).status(),
  ).toBe(403);
  expect((await page.request.get("/api/files/unknown.png")).status()).toBe(401);
  expect(
    await db.accountHandoff.findUniqueOrThrow({ where: { id: handoffId } }),
  ).toMatchObject({ encryptedPassword: "" });
});

test("a colleague hands off substrates and the specialist reads only testing in English and Chinese on a phone", async ({
  page,
}) => {
  await db.user.update({
    where: { id: testerId },
    data: {
      passwordHash: await bcrypt.hash(newPassword, 4),
      mustChangePassword: false,
      temporaryPasswordExpiresAt: null,
      sessionVersion: { increment: 1 },
    },
  });
  await db.accountHandoff.update({
    where: { id: handoffId },
    data: { encryptedPassword: "", revokedAt: new Date() },
  });
  await login(page, managerEmail, managerPassword);
  await expect(page).toHaveURL(/\/$/);
  await page.goto(`/account-handoffs/${handoffId}`);
  await expect(
    page.getByText(/Temporary credentials are no longer available/),
  ).toBeVisible();
  await page.goto(`/experiments/${experimentId}/capture`);
  await page
    .getByRole("button", { name: "Notify testing specialist", exact: true })
    .click();
  await page.getByLabel("Substrate photo", { exact: true }).setInputFiles({
    name: "substrates.png",
    mimeType: "image/png",
    buffer: image,
  });
  await page
    .getByLabel("Testing instructions (optional)", { exact: true })
    .fill("Ready for forward and reverse scans");
  await page
    .getByRole("button", { name: "Send testing request", exact: true })
    .click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: /Testing request saved|Testing specialist notified/ }),
  ).toBeVisible();
  expect(await db.testingRequest.count({ where: { organizationId } })).toBe(1);
  expect(
    await db.notification.count({
      where: { userId: testerId, kind: "testing_requested" },
    }),
  ).toBe(1);
  await page.context().clearCookies();
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, testerEmail, newPassword);
  await expect(page).toHaveURL(/\/testing$/);
  await page
    .getByRole("button", { name: "Notifications", exact: true })
    .click();
  await page
    .getByRole("link")
    .filter({ hasText: "sent a JV testing request" })
    .click();
  await expect(
    page.getByRole("heading", { name: experimentCode, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Ready for forward and reverse scans", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: "Substrate photo", exact: true }),
  ).toBeVisible();
  expect(
    await page
      .getByRole("img", { name: "Substrate photo", exact: true })
      .evaluate(
        (img: HTMLImageElement) => img.complete && img.naturalWidth > 0,
      ),
  ).toBe(true);
  expect(await page.locator("body").innerText()).not.toMatch(
    /PRIVATE PREPARATION|PRIVATE HYPOTHESIS/,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/jv-testing-phone-en.png",
    fullPage: true,
  });
  await page
    .context()
    .addCookies([
      { name: "pheno_lang", value: "zh", url: "http://127.0.0.1:3467" },
    ]);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "JV 测试要求", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/jv-testing-phone-zh.png",
    fullPage: true,
  });
});
