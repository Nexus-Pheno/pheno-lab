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
const password = "membership-browser-test-only";
const delegateEmail = `delegate-${suffix}@example.test`;
const ordinaryEmail = `ordinary-${suffix}@example.test`;
const pendingEmail = `pending-${suffix}@example.test`;
const invitedEmail = `invited-${suffix}@example.test`;
let organizationId = "";

test.beforeAll(async () => {
  const org = await prisma.organization.create({
    data: {
      name: "Membership browser test",
      slug: `membership-browser-${suffix}`,
    },
  });
  organizationId = org.id;
  const passwordHash = await bcrypt.hash(password, 4);
  await prisma.user.createMany({
    data: [
      {
        organizationId,
        name: "Member delegate",
        email: delegateEmail,
        role: "MANAGER",
        memberAdmin: true,
        passwordHash,
      },
      {
        organizationId,
        name: "Ordinary manager",
        email: ordinaryEmail,
        role: "MANAGER",
        passwordHash,
      },
      {
        organizationId,
        name: "New colleague",
        email: pendingEmail,
        active: false,
        pendingApproval: true,
        passwordHash,
      },
    ],
  });
});

test.afterAll(async () => {
  if (organizationId) {
    await prisma.auditEvent.deleteMany({ where: { organizationId } });
    await prisma.user.deleteMany({ where: { organizationId } });
    await prisma.organization.delete({ where: { id: organizationId } });
  }
  await prisma.$disconnect();
});

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/$/);
}

test("delegate approves, invites and creates a technician without admin controls", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await login(page, delegateEmail);
  await page.goto("/profile");
  await page.getByRole("link", { name: "Members", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Members", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Organization settings" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Responsible people" }),
  ).toHaveCount(0);
  await expect(page.getByText("Legacy data", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Reject", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Copy invitation link" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(
    /\/register$/,
  );
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(
    page.getByText("No registrations are waiting for approval."),
  ).toBeVisible();
  const approved = await prisma.user.findUniqueOrThrow({
    where: { email: pendingEmail },
  });
  expect(approved).toMatchObject({
    active: true,
    pendingApproval: false,
    role: "TECHNICIAN",
  });
  const add = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Add member", exact: true }),
  });
  await expect(add.locator("select option")).toHaveCount(1);
  await add.locator("input").nth(0).fill("Invited colleague");
  await add.locator('input[type="email"]').fill(invitedEmail);
  await add.getByRole("button", { name: "Generate password" }).click();
  await add.getByRole("button", { name: "Create account" }).click();
  await expect(
    page.getByText("Account created — share these credentials:"),
  ).toBeVisible();
  expect(
    await prisma.user.findUniqueOrThrow({ where: { email: invitedEmail } }),
  ).toMatchObject({ organizationId, role: "TECHNICIAN", memberAdmin: false });
});

test("membership page fits a phone and remains closed to an ordinary manager", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, delegateEmail);
  await page.goto("/organization");
  await expect(
    page.getByRole("heading", { name: "Invite new members" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/member-stewardship-mobile.png",
    fullPage: true,
  });
  await page
    .context()
    .addCookies([
      { name: "pheno_lang", value: "zh", url: "http://127.0.0.1:3467" },
    ]);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "成员管理", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "邀请新成员", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/member-stewardship-mobile-zh.png",
    fullPage: true,
  });
  await page.context().clearCookies();
  await login(page, ordinaryEmail);
  const denied = await page.goto("/organization");
  expect(denied?.status()).toBe(404);
  await expect(
    page.getByRole("heading", { name: "Invite new members" }),
  ).toHaveCount(0);
});
