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
const authorEmail = `review-author-${suffix}@example.test`;
const stewardEmail = `review-steward-${suffix}@example.test`;
const password = "review-e2e-test-only-password";
let organizationId = "";
let authorId = "";
let stewardId = "";

test.beforeAll(async () => {
  const organization = await prisma.organization.create({
    data: { name: "Review browser test", slug: `review-browser-${suffix}` },
  });
  organizationId = organization.id;
  const passwordHash = await bcrypt.hash(password, 4);
  const author = await prisma.user.create({
    data: {
      organizationId,
      email: authorEmail,
      name: "Review author",
      role: "TECHNICIAN",
      passwordHash,
    },
  });
  authorId = author.id;
  const steward = await prisma.user.create({
    data: {
      organizationId,
      email: stewardEmail,
      name: "Review steward",
      role: "MANAGER",
      passwordHash,
      materialAdmin: true,
      recipeSteward: true,
    },
  });
  stewardId = steward.id;
  await prisma.materialCategoryDef.create({
    data: { organizationId, code: "OTHER", name: "Review category" },
  });
});

test.afterAll(async () => {
  if (organizationId) {
    await prisma.experiment.deleteMany({ where: { organizationId } });
    await prisma.notification.deleteMany({ where: { organizationId } });
    await prisma.auditEvent.deleteMany({ where: { organizationId } });
    await prisma.material.deleteMany({ where: { organizationId } });
    await prisma.recipe.deleteMany({ where: { organizationId } });
    await prisma.materialCategoryDef.deleteMany({ where: { organizationId } });
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
  await page.goto("/library");
}

test("technician suggestions apply only after a steward approves", async ({
  page,
  browser,
}, testInfo) => {
  const material = await prisma.material.create({
    data: { organizationId, name: "Browser material", category: "OTHER" },
  });
  await login(page, authorEmail);
  await page.getByRole("heading", { name: "Materials", exact: true }).click();
  await page.getByRole("heading", { name: "Review category" }).click();
  await page.getByRole("button", { name: /Browser material/ }).click();
  const modal = page.getByRole("dialog", { name: "Browser material" });
  await modal.locator("input").first().fill("Approved browser material");
  await modal.getByRole("button", { name: "Submit for approval" }).click();
  await expect(modal).toBeHidden();
  expect(
    (await prisma.material.findUniqueOrThrow({ where: { id: material.id } }))
      .name,
  ).toBe("Browser material");
  const reviewer = await browser.newPage({
    baseURL: testInfo.project.use.baseURL,
  });
  try {
    await login(reviewer, stewardEmail);
    const proposal = reviewer
      .locator("details")
      .filter({ hasText: "Browser material" });
    await proposal.locator("summary").click();
    await expect(proposal).toContainText("Approved browser material");
    await reviewer.setViewportSize({ width: 390, height: 844 });
    await reviewer.screenshot({
      path: testInfo.outputPath("materials-review-mobile.png"),
      fullPage: true,
    });
    await proposal
      .getByRole("button", { name: "Approve", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (
            await prisma.material.findUniqueOrThrow({
              where: { id: material.id },
            })
          ).name,
      )
      .toBe("Approved browser material");
  } finally {
    await reviewer.close();
  }
});

test("creators read pending recipes but cannot edit; stewards approve them", async ({
  page,
  browser,
}, testInfo) => {
  const recipe = await prisma.recipe.create({
    data: {
      organizationId,
      createdById: authorId,
      name: "Browser pending recipe",
      approvalStatus: "PENDING",
      payload: {
        components: [{ material: "Browser ingredient", amount: "1" }],
        solvents: "",
        concentration: "",
        procedure: "Browser procedure",
      },
    },
  });
  await login(page, authorEmail);
  await page.getByRole("heading", { name: "Recipes", exact: true }).click();
  await page.getByRole("button", { name: /Browser pending recipe/ }).click();
  const modal = page.getByRole("dialog", { name: recipe.name });
  await expect(modal.locator("input").first()).toBeDisabled();
  await expect(
    modal.getByRole("button", { name: "Save", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("recipe-readonly-desktop.png"),
    fullPage: true,
  });
  const reviewer = await browser.newPage({
    baseURL: testInfo.project.use.baseURL,
  });
  try {
    await login(reviewer, stewardEmail);
    await reviewer
      .getByRole("heading", { name: "Recipes", exact: true })
      .click();
    await reviewer
      .getByRole("button", { name: /Browser pending recipe/ })
      .click();
    await reviewer
      .getByRole("dialog", { name: recipe.name })
      .getByRole("button", { name: "Approve", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await prisma.recipe.findUniqueOrThrow({ where: { id: recipe.id } }))
            .approvalStatus,
      )
      .toBe("APPROVED");
  } finally {
    await reviewer.close();
  }
});

test("a technician creates a recipe as a pending submission", async ({
  page,
}) => {
  await login(page, authorEmail);
  await page.getByRole("heading", { name: "Recipes", exact: true }).click();
  await page.getByRole("button", { name: "Add recipe", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "New recipe" });
  await modal.locator("input").first().fill("Browser-created recipe");
  await modal.getByRole("button", { name: "Submit for approval" }).click();
  await expect(modal).toBeHidden();
  const recipe = await prisma.recipe.findFirstOrThrow({
    where: { organizationId, name: "Browser-created recipe" },
  });
  expect(recipe.createdById).toBe(authorId);
  expect(recipe.approvalStatus).toBe("PENDING");
});

test("a technician starts a new draft from an organization template", async ({
  page,
}, testInfo) => {
  const source = await prisma.experiment.create({
    data: {
      organizationId,
      createdById: stewardId,
      code: `TPL-${suffix}`,
      title: "Browser starting template",
      templatePinnedAt: new Date(),
    },
  });
  await login(page, authorEmail);
  await page.goto("/");
  await page
    .getByRole("button", { name: "New experiment", exact: true })
    .click();
  await page
    .getByRole("button", { name: "From template / previous", exact: true })
    .click();
  await expect(
    page.getByText("Pinned templates", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("template-picker-desktop.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: /Browser starting template/ }).click();
  await expect(page).toHaveURL(/\/experiments\/[^/]+$/);
  const copied = await prisma.experiment.findFirstOrThrow({
    where: { organizationId, createdById: authorId, title: source.title },
    include: { runs: true },
  });
  expect(copied.id).not.toBe(source.id);
  expect(copied.status).toBe("DRAFT");
  expect(copied.templatePinnedAt).toBeNull();
  expect(copied.runs).toHaveLength(0);
});
