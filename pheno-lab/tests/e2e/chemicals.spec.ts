import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import initRDKit from "@rdkit/rdkit";
import { chemicalWorkbook } from "../helpers/chemical-workbook";
import { assertSafeTestDatabaseUrl } from "../../src/infrastructure/db/test-database";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL required");
assertSafeTestDatabaseUrl({
  testDatabaseUrl,
  primaryDatabaseUrl: process.env.DATABASE_URL,
  ci: process.env.CI === "true",
});
const db = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
const referenceSmiles = "C1=CC=C2C(=C1)C3=CC=CC=C3N2CCP(=O)(O)O";
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
    for (const batch of await db.chemicalImportBatch.findMany({
      where: { organizationId: orgId },
    }))
      await rm(path.join("/tmp/pheno-lab-e2e-uploads", batch.sourcePath), {
        force: true,
      });
    await db.material.deleteMany({ where: { organizationId: orgId } });
    await db.chemicalImportBatch.deleteMany({
      where: { organizationId: orgId },
    });
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
test("portal-ready notice is bilingual and opens the authorized chemistry page", async ({
  page,
}) => {
  await db.notification.create({
    data: {
      organizationId: orgId,
      userId: ownerId,
      kind: "chemicals_ready",
      actorName: "Synthetic Sender",
      entityLabel: "Pheno Chemicals",
      href: "/chemicals",
    },
  });
  await login(page, ownerEmail);
  for (const language of ["en", "zh"] as const) {
    await page
      .context()
      .addCookies([
        { name: "pheno_lang", value: language, url: "http://127.0.0.1:3467" },
      ]);
    await page.goto("/profile");
    await page
      .getByRole("button", {
        name: language === "en" ? /Notifications/ : /通知/,
      })
      .click();
    const notice = page.getByRole("link").filter({
      hasText:
        language === "en"
          ? "enabled your private material-entry portal"
          : "已为你开通私有材料录入入口",
    });
    await expect(notice).toContainText("Pheno Chemicals");
    await notice.click();
    await expect(page).toHaveURL(/\/chemicals$/);
    await expect(
      page.getByRole("heading", { name: "Pheno Chemicals", exact: true }),
    ).toBeVisible();
  }
});
test("authorized row entry validates, saves locally rendered structure and creates a public picker entry", async ({
  page,
}) => {
  await db.material.create({
    data: {
      organizationId: orgId,
      name: "Legacy shared SAM",
      category: "SAM",
      smiles: "CCO",
    },
  });
  await login(page, ownerEmail);
  await page.goto("/profile");
  await page
    .getByRole("link", { name: "Pheno Chemicals", exact: true })
    .click();
  await expect(page.getByTestId("chemical-row")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Add material row", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Material name 1", exact: true })
    .fill(`Browser 2PACz ${suffix}`);
  await expect(
    page.getByRole("textbox", { name: "Category 1", exact: true }),
  ).toHaveValue("SAM");
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await page
    .getByRole("textbox", { name: "SMILES 1", exact: true })
    .fill(referenceSmiles);
  await expect(page.getByTestId("row-molecule").first()).toBeVisible();
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
    where: { organizationId: orgId, name: `Browser 2PACz ${suffix}` },
    include: { chemistry: true },
  });
  materialId = material.id;
  expect(material.smiles).toBe(referenceSmiles);
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
    materials: expect.arrayContaining([
      expect.objectContaining({ name: material.name, smiles: referenceSmiles }),
    ]),
  });
  await page.reload();
  await expect(page.getByTestId("row-molecule").first()).toBeVisible();
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
  ).toBe(referenceSmiles);
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
  expect(await library.text()).not.toContain(referenceSmiles);
});
test("bilingual workbench and focused molecule view fit desktop, tablet and narrow phones", async ({
  page,
}) => {
  // A full page is needed: offscreen accessible row labels must stay inside
  // the registry scroll owner rather than extending the document height.
  const rdkit = await initRDKit({ print: () => {}, printErr: () => {} });
  const mol = rdkit.get_mol(referenceSmiles)!;
  const svg = mol.get_svg(560, 360);
  const canonicalSmiles = mol.get_smiles();
  mol.delete();
  for (let index = 0; index < 44; index++) {
    const key = `organizations/${orgId}/chemicals/${crypto.randomUUID()}.svg`;
    const destination = path.join("/tmp/pheno-lab-e2e-uploads", key);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, svg);
    await db.material.create({
      data: {
        organizationId: orgId,
        name: `ZZ synthetic SAM ${String(index).padStart(2, "0")} with a longer display name`,
        category: "SAM",
        smiles: referenceSmiles,
        chemistry: {
          create: {
            inSamRegistry: true,
            requestId: crypto.randomUUID(),
            canonicalSmiles,
            inputSha256: crypto
              .createHash("sha256")
              .update(referenceSmiles)
              .digest("hex"),
            structurePath: key,
            structureSha256: crypto
              .createHash("sha256")
              .update(svg)
              .digest("hex"),
            structureBytes: Buffer.byteLength(svg),
            atomCount: 19,
            engineVersion: `RDKit ${rdkit.version()}`,
          },
        },
      },
    });
  }
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
      await expect(page.getByTestId("chemical-row")).toHaveCount(40);
      await expect(page.getByTestId("row-molecule").first()).toBeVisible();
      await expect(page.getByTestId("row-molecule").first()).toHaveJSProperty(
        "naturalWidth",
        560,
      );
      const registry = page.getByTestId("registry-body");
      expect(
        await registry.evaluate(
          (element) => element.scrollHeight > element.clientHeight,
        ),
      ).toBe(true);
      await registry.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect(page.getByTestId("chemical-row").last()).toBeInViewport();
      await expect(
        page.getByRole("link", {
          name: language === "en" ? "Next" : "下一页",
          exact: true,
        }),
      ).toBeInViewport();
      await registry.evaluate((element) => {
        element.scrollTop = 0;
      });
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
        expect(
          await page.evaluate(
            () => document.documentElement.scrollHeight > innerHeight,
          ),
        ).toBe(false);
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

test("Excel template, review, atomic import, private source and bilingual bulk views", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await login(page, ownerEmail);
  await page
    .context()
    .addCookies([
      { name: "pheno_lang", value: "en", url: "http://127.0.0.1:3467" },
    ]);
  await page.goto("/chemicals");
  await page.getByRole("link", { name: "Bulk upload", exact: true }).click();
  await expect(page).toHaveURL(/\/chemicals\/bulk$/);
  const template = await page.request.get("/api/chemicals/template");
  expect(template.status()).toBe(200);
  expect(template.headers()["content-disposition"]).toContain(".xlsx");
  expect(template.headers()["cache-control"]).toContain("no-store");
  expect((await template.body()).byteLength).toBeGreaterThan(1000);
  const input = page.locator('input[type="file"]');
  await input.setInputFiles({
    name: "error.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from(chemicalWorkbook([["Bad fixture", "invalid-smiles"]])),
  });
  await page
    .getByRole("button", { name: "Validate file", exact: true })
    .click();
  await expect(page.getByTestId("bulk-row")).toContainText(
    "SMILES could not be validated",
  );
  await expect(
    page.getByRole("button", { name: "Import materials", exact: true }),
  ).toBeDisabled();
  expect(
    await db.chemicalImportBatch.count({ where: { organizationId: orgId } }),
  ).toBe(0);
  const bytes = Buffer.from(
    chemicalWorkbook([
      [`Uploaded SAM A ${suffix}`, referenceSmiles],
      [`Uploaded SAM B ${suffix}`, "CCO"],
    ]),
  );
  await input.setInputFiles({
    name: "materials.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: bytes,
  });
  await page
    .getByRole("button", { name: "Validate file", exact: true })
    .click();
  await expect(page.getByTestId("bulk-row")).toHaveCount(2);
  await expect(
    page.getByTestId("bulk-row").first().locator("img"),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Import materials", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "2 SAM materials imported",
  );
  const sourceHref = await page
    .getByRole("link", { name: "Download uploaded workbook", exact: true })
    .getAttribute("href");
  const source = await page.request.get(sourceHref!);
  expect(source.status()).toBe(200);
  expect(await source.body()).toEqual(bytes);
  expect(
    await db.chemicalImportBatch.count({ where: { organizationId: orgId } }),
  ).toBe(1);
  expect(
    await db.material.count({
      where: { organizationId: orgId, name: { startsWith: "Uploaded SAM" } },
    }),
  ).toBe(2);
  const qa = "/tmp/pheno-chemicals-bulk-ui-qa";
  await mkdir(qa, { recursive: true });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const language of ["en", "zh"] as const)
    for (const [width, height] of [
      [1440, 900],
      [1024, 768],
      [390, 844],
      [320, 700],
    ]) {
      await page
        .context()
        .addCookies([
          { name: "pheno_lang", value: language, url: "http://127.0.0.1:3467" },
        ]);
      await page.setViewportSize({ width, height });
      await page.goto("/chemicals/bulk");
      await page.locator('input[type="file"]').setInputFiles({
        name: "preview.xlsx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: Buffer.from(
          chemicalWorkbook([["Preview only SAM", referenceSmiles]]),
        ),
      });
      await page
        .getByRole("button", {
          name: language === "en" ? "Validate file" : "验证文件",
          exact: true,
        })
        .click();
      await expect(page.getByTestId("bulk-row").locator("img")).toBeVisible();
      await expect(
        page.getByRole("link", {
          name:
            language === "en" ? "Download Excel template" : "下载 Excel 模板",
          exact: true,
        }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth > innerWidth ||
            document.documentElement.scrollHeight > innerHeight,
        ),
      ).toBe(false);
      await page.screenshot({ path: `${qa}/${language}-${width}.png` });
    }
  expect(errors).toEqual([]);
  await page.context().clearCookies();
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, ordinaryEmail);
  expect((await page.request.get("/chemicals/bulk")).status()).toBe(404);
  expect((await page.request.get("/api/chemicals/template")).status()).toBe(
    404,
  );
  expect((await page.request.get(sourceHref!)).status()).toBe(404);
  expect(
    (
      await page.request.post("/api/chemicals/bulk", {
        headers: { Origin: "http://127.0.0.1:3467" },
        multipart: {
          mode: "preview",
          file: {
            name: "materials.xlsx",
            mimeType:
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            buffer: bytes,
          },
        },
      })
    ).status(),
  ).toBe(404);
});
