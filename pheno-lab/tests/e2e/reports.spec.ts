import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { createHash } from "node:crypto";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
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
const password = "report-browser-test-password";
const managerEmail = `reports-manager-${suffix}@example.test`;
const ordinaryEmail = `reports-ordinary-${suffix}@example.test`;
let orgId = "",
  reportId = "",
  filePath = "";
const html =
  '<!DOCTYPE html><html><head><style>body{font-family:sans-serif}button{min-height:44px}</style></head><body><h1 id="title">Private materials analysis</h1><button id="zh">中文</button><p>COMPLETE PRIVATE REPORT BODY</p><script>document.getElementById("zh").addEventListener("click",()=>document.getElementById("title").textContent="材料分析报告");</script></body></html>';
test.beforeAll(async () => {
  const org = await db.organization.create({
    data: {
      name: "Reports browser fixture",
      slug: `reports-browser-${suffix}`,
    },
  });
  orgId = org.id;
  const manager = await db.user.create({
    data: {
      organizationId: orgId,
      name: "Report Manager",
      email: managerEmail,
      role: "MANAGER",
      reportAccess: true,
      passwordHash: await bcrypt.hash(password, 4),
    },
  });
  await db.user.create({
    data: {
      organizationId: orgId,
      name: "Report Member",
      email: ordinaryEmail,
      role: "MANAGER",
      passwordHash: await bcrypt.hash(password, 4),
    },
  });
  reportId = crypto.randomUUID();
  const storedPath = `organizations/${orgId}/reports/${reportId}.html`;
  filePath = path.join("/tmp/pheno-lab-e2e-uploads", storedPath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, html);
  await db.labReport.create({
    data: {
      id: reportId,
      organizationId: orgId,
      publicationKey: "browser-report",
      titleEn: "Materials research report",
      titleZh: "材料研究报告",
      generatedAt: new Date("2026-10-12T03:00:00Z"),
      storedPath,
      contentSha256: createHash("sha256").update(html).digest("hex"),
      contentBytes: Buffer.byteLength(html),
      recipientIds: [manager.id],
    },
  });
  await db.notification.create({
    data: {
      organizationId: orgId,
      userId: manager.id,
      kind: "report_published",
      actorName: "Pheno Lab",
      entityLabel: "Materials research report",
      href: `/reports/${reportId}`,
    },
  });
});
test.afterAll(async () => {
  if (filePath) await rm(filePath, { force: true });
  if (orgId) {
    const where = { organizationId: orgId };
    await db.labReport.deleteMany({ where });
    await db.notification.deleteMany({ where });
    await db.auditEvent.deleteMany({ where });
    await db.user.deleteMany({ where });
    await db.organization.delete({ where: { id: orgId } });
  }
  await db.$disconnect();
});
async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/$/);
}
test("manager notification opens the complete isolated report and bilingual controls work", async ({
  page,
}) => {
  await login(page, managerEmail);
  await page
    .getByRole("button", { name: "Notifications", exact: true })
    .click();
  await page.getByRole("link", { name: /published a research report/ }).click();
  await expect(page).toHaveURL(`/reports/${reportId}`);
  const frame = page.frameLocator("iframe");
  await expect(frame.getByText("COMPLETE PRIVATE REPORT BODY")).toBeVisible();
  await frame.getByRole("button", { name: "中文" }).click();
  await expect(
    frame.getByRole("heading", { name: "材料分析报告" }),
  ).toBeVisible();
  const response = await page.request.get(`/api/reports/${reportId}/content`);
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(response.headers()["content-security-policy"]).not.toContain(
    "allow-same-origin",
  );
});
test("regular users see locked titles/date in both languages at desktop and mobile but cannot fetch content", async ({
  page,
  context,
}) => {
  await login(page, ordinaryEmail);
  for (const [lang, title, locked] of [
    ["en", "Materials research report", "Restricted"],
    ["zh", "材料研究报告", "访问受限"],
  ]) {
    await context.addCookies([
      { name: "pheno_lang", value: lang, url: "http://127.0.0.1:3467" },
    ]);
    for (const width of [1440, 1024, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/reports");
      await expect(page.getByText(title, { exact: true })).toBeVisible();
      await expect(page.getByText(locked, { exact: true })).toBeVisible();
      await expect(
        page.getByText("2026-10-12 11:00 (UTC+8)", { exact: true }),
      ).toBeVisible();
      expect(
        await page
          .locator("main")
          .evaluate((e) => e.scrollWidth <= e.clientWidth),
      ).toBe(true);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await expect(page.locator(`a[href="/reports/${reportId}"]`)).toHaveCount(
        0,
      );
    }
  }
  expect(
    (await page.request.get(`/api/reports/${reportId}/content`)).status(),
  ).toBe(404);
  await page.goto(`/reports/${reportId}`);
  await expect(page.locator("iframe")).toHaveCount(0);
  expect(await page.content()).not.toContain("COMPLETE PRIVATE REPORT BODY");
});
