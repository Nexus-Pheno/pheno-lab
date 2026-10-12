import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { mkdir, rm } from "node:fs/promises";
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
const suffix = crypto.randomUUID(),
  password = "chemical-browser-test-password";
const ownerEmail = `chemical-owner-${suffix}@example.test`,
  ordinaryEmail = `chemical-ordinary-${suffix}@example.test`;
let orgId = "",
  ownerId = "",
  materialId = "";
test.beforeAll(async () => {
  const org = await db.organization.create({
    data: {
      name: "Chemical browser fixture",
      slug: `chemical-browser-${suffix}`,
    },
  });
  orgId = org.id;
  const owner = await db.user.create({
    data: {
      organizationId: orgId,
      name: "Chemical Owner",
      email: ownerEmail,
      role: "MANAGER",
      chemicalAccess: true,
      passwordHash: await bcrypt.hash(password, 4),
    },
  });
  ownerId = owner.id;
  await db.user.create({
    data: {
      organizationId: orgId,
      name: "Ordinary Administrator",
      email: ordinaryEmail,
      role: "ADMIN",
      passwordHash: await bcrypt.hash(password, 4),
    },
  });
});
test.afterAll(async () => {
  if (orgId) {
    for (const evidence of await db.materialChemistry.findMany({
      where: { material: { organizationId: orgId } },
    }))
      await rm(
        path.join("/tmp/pheno-lab-e2e-uploads", evidence.structurePath),
        { force: true },
      );
    await db.material.deleteMany({ where: { organizationId: orgId } });
    await db.materialCategoryDef.deleteMany({
      where: { organizationId: orgId },
    });
    await db.auditEvent.deleteMany({ where: { organizationId: orgId } });
    await db.user.deleteMany({ where: { organizationId: orgId } });
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
test("authorized row entry validates, saves locally rendered structure and creates a public picker entry", async ({
  page,
}) => {
  await login(page, ownerEmail);
  await page.goto("/profile");
  await page
    .getByRole("link", { name: "Pheno Chemicals", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Add material row", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Material name 1", exact: true })
    .fill(`Browser ethanol ${suffix}`);
  await page
    .getByRole("combobox", { name: "Category 1", exact: true })
    .selectOption("SOLVENT");
  await page
    .getByRole("textbox", { name: "SMILES 1", exact: true })
    .fill("CCO");
  await expect(
    page.getByTestId("molecule-inspector").locator("img"),
  ).toBeVisible();
  await page
    .getByTestId("chemical-row")
    .first()
    .getByRole("button", { name: "Save row", exact: true })
    .click();
  await expect(page.getByTestId("chemical-row").first()).toContainText("Saved");
  const material = await db.material.findFirstOrThrow({
    where: { organizationId: orgId, name: `Browser ethanol ${suffix}` },
    include: { chemistry: true },
  });
  materialId = material.id;
  expect(material.smiles).toBe("CCO");
  expect(material.chemistry?.structurePath).toContain(`/chemicals/`);
  const image = await page.request.get(
    `/api/chemicals/${material.id}/structure`,
  );
  expect(image.status()).toBe(200);
  expect(await image.text()).toContain("<svg");
  expect(image.headers()["cache-control"]).toContain("no-store");
  const exported = await page.request.get("/api/chemicals/analysis");
  expect(exported.status()).toBe(200);
  expect(await exported.json()).toMatchObject({
    classification: "private_chemistry",
    materials: [{ name: material.name, smiles: "CCO" }],
  });
  await page
    .getByRole("slider", { name: "Inspector width", exact: true })
    .focus();
  await page
    .getByRole("slider", { name: "Inspector width", exact: true })
    .press("ArrowRight");
  await expect(page.getByTestId("molecule-inspector")).toHaveCSS(
    "width",
    "380px",
  );
  await page
    .getByRole("button", { name: "Hide structure", exact: true })
    .click();
  await expect(page.getByTestId("molecule-inspector")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Inspect structure", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Focus structure", exact: true })
    .click();
  await expect(page.getByTestId("registry-body")).not.toBeVisible();
  await page
    .getByRole("button", { name: "Hide structure", exact: true })
    .click();
  await expect(page.getByTestId("registry-body")).toBeVisible();
  await page.getByRole("button", { name: "Reset view", exact: true }).click();
  expect(
    await page.evaluate(() => localStorage.getItem("pheno-chemical-view")),
  ).toBe(JSON.stringify({ width: 360, visible: true }));
  await page
    .getByRole("textbox", { name: "SMILES 1", exact: true })
    .fill("invalid-smiles");
  await expect(page.getByTestId("molecule-inspector")).toContainText(
    "could not be validated",
  );
  await page
    .getByTestId("chemical-row")
    .first()
    .getByRole("button", { name: "Save row", exact: true })
    .click();
  await expect(page.getByTestId("chemical-row").first()).toContainText(
    "could not be validated",
  );
  expect(
    (await db.material.findUniqueOrThrow({ where: { id: material.id } }))
      .smiles,
  ).toBe("CCO");
});
test("ordinary administrator has public material access but no portal, private export, image or SMILES payload", async ({
  page,
}) => {
  await login(page, ordinaryEmail);
  await page.goto("/profile");
  await expect(
    page.getByRole("link", { name: "Pheno Chemicals", exact: true }),
  ).toHaveCount(0);
  expect((await page.request.get("/chemicals")).status()).toBe(404);
  expect((await page.request.get("/api/chemicals/analysis")).status()).toBe(
    404,
  );
  if (materialId)
    expect(
      (
        await page.request.get(`/api/chemicals/${materialId}/structure`)
      ).status(),
    ).toBe(404);
  const library = await page.request.get("/library");
  expect(library.status()).toBe(200);
  expect(await library.text()).not.toContain('\\"smiles\\":\\"CCO\\"');
});
test("bilingual workbench and focused molecule view fit desktop, tablet and narrow phones", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await login(page, ownerEmail);
  const qa = path.join("/tmp/pheno-chemicals-ui-qa");
  await mkdir(qa, { recursive: true });
  for (const language of ["en", "zh"] as const) {
    await db.user.update({ where: { id: ownerId }, data: { language } });
    await page
      .context()
      .addCookies([
        { name: "pheno_lang", value: language, url: "http://127.0.0.1:3467" },
      ]);
    for (const [width, height] of [
      [1440, 900],
      [1024, 768],
      [390, 844],
      [320, 700],
    ]) {
      await page.setViewportSize({ width, height });
      await page.goto("/chemicals");
      await expect(
        page.getByRole("heading", { name: "Pheno Chemicals", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", {
          name: language === "en" ? "Add material row" : "新增材料行",
          exact: true,
        }),
      ).toBeVisible();
      const state = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth,
        vertical: document.documentElement.scrollHeight > innerHeight,
        broken: [...document.images].filter(
          (i) => !i.complete || !i.naturalWidth,
        ).length,
      }));
      expect(state.overflow).toBe(false);
      expect(state.vertical).toBe(false);
      expect(state.broken).toBe(0);
      if (width < 1280) {
        await page
          .getByRole("button", {
            name: language === "en" ? "Inspect structure" : "查看结构",
            exact: true,
          })
          .last()
          .click();
        await expect(page.getByTestId("molecule-inspector")).toBeVisible();
        await expect(
          page.getByTestId("molecule-inspector").locator("img"),
        ).toBeVisible();
        await page.screenshot({
          path: path.join(qa, `${language}-${width}-structure.png`),
        });
        await page
          .getByRole("button", {
            name: language === "en" ? "Return to rows" : "返回材料行",
            exact: true,
          })
          .last()
          .click();
      } else
        await expect(
          page.getByTestId("molecule-inspector").locator("img"),
        ).toBeVisible();
      await page.screenshot({
        path: path.join(qa, `${language}-${width}.png`),
      });
    }
  }
  expect(pageErrors).toEqual([]);
});
