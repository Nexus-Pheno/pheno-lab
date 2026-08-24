import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { E2E_EMAIL, E2E_MANAGER_EMAIL, E2E_PASSWORD } from "./global-setup";

test("liveness endpoint identifies the service", async ({ request }) => {
  const response = await request.get("/api/health/live");
  expect(response.ok()).toBe(true);
  await expect(response.json()).resolves.toMatchObject({
    service: "pheno-lab",
    status: "live",
  });
});

test("login surface is available", async ({ page }) => {
  await page.goto("/login");
  await expect(page.locator("#email")).toBeVisible();
  await expect(page.locator("#password")).toBeVisible();
  await expect(page.locator('button[type="submit"]')).toBeVisible();
});

test("a manager can create and edit an experiment through the Web UI", async ({
  page,
}) => {
  const testDatabaseUrl = process.env.TEST_DATABASE_URL;
  if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is required");
  const prisma = new PrismaClient({
    datasources: { db: { url: testDatabaseUrl } },
  });
  let experimentId: string | undefined;
  try {
    await page.goto("/login");
    await page.locator("#email").fill(E2E_MANAGER_EMAIL);
    await page.locator("#password").fill(E2E_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await expect(page).toHaveURL(/\/$/);

    await page.getByRole("button", { name: "New experiment" }).click();
    await page.getByRole("button", { name: "Real experiment" }).click();
    await expect(page).toHaveURL(/\/experiments\/[^/]+$/);
    experimentId = new URL(page.url()).pathname.split("/").at(-1);
    expect(experimentId).toBeTruthy();
    await expect(
      page.getByText("Untitled experiment", { exact: true }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Settings" }).click();
    const modal = page
      .getByText("Experiment settings", { exact: true })
      .locator("..")
      .locator("..");
    const title = modal.locator("input").first();
    const nextTitle = `E2E refactor ${crypto.randomUUID()}`;
    await title.fill(nextTitle);
    await title.blur();
    await expect(page.getByText(nextTitle, { exact: true })).toBeVisible();

    await expect
      .poll(() =>
        prisma.auditEvent.count({
          where: {
            entityId: experimentId,
            action: { in: ["experiment.create", "experiment.update"] },
          },
        }),
      )
      .toBe(2);
  } finally {
    if (experimentId) {
      await prisma.auditEvent.deleteMany({ where: { entityId: experimentId } });
      await prisma.experiment.deleteMany({ where: { id: experimentId } });
    }
    await prisma.$disconnect();
  }
});

test("a technician can upload and read a capture image", async ({ page }) => {
  await page.goto("/login");
  await page.locator("#email").fill(E2E_EMAIL);
  await page.locator("#password").fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/$/);

  const upload = await page.request.post("/api/upload", {
    multipart: {
      file: {
        name: "capture.png",
        mimeType: "image/png",
        buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      },
    },
  });
  expect(upload.status()).toBe(200);
  const { fileName } = (await upload.json()) as { fileName: string };
  expect(fileName).toMatch(/^organizations\/.+\/users\/.+\/images\//);

  const download = await page.request.get(`/api/files/${fileName}`);
  expect(download.status()).toBe(200);
  expect(download.headers()["x-content-type-options"]).toBe("nosniff");
});

test("an existing session loses access when its user is deactivated", async ({
  page,
}) => {
  const testDatabaseUrl = process.env.TEST_DATABASE_URL;
  if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is required");
  const prisma = new PrismaClient({
    datasources: { db: { url: testDatabaseUrl } },
  });
  try {
    await page.goto("/login");
    await page.locator("#email").fill(E2E_EMAIL);
    await page.locator("#password").fill(E2E_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await expect(page).toHaveURL(/\/$/);

    await prisma.user.update({
      where: { email: E2E_EMAIL },
      data: { active: false },
    });
    const denied = await page.request.post("/api/upload", {
      multipart: {
        file: {
          name: "denied.png",
          mimeType: "image/png",
          buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        },
      },
    });
    expect(denied.status()).toBe(403);
  } finally {
    await prisma.user.update({
      where: { email: E2E_EMAIL },
      data: { active: true },
    });
    await prisma.$disconnect();
  }
});
