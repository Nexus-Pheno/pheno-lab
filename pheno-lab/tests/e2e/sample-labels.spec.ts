import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { E2E_MANAGER_EMAIL, E2E_PASSWORD } from "./global-setup";

test("issued labels and QR destinations survive assignment and test-plan edits", async ({
  page,
}) => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is required");
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  let id: string | undefined;
  try {
    await page.goto("/login");
    await page.locator("#email").fill(E2E_MANAGER_EMAIL);
    await page.locator("#password").fill(E2E_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await expect(page).toHaveURL(/\/$/);
    await page.getByRole("button", { name: "New experiment" }).click();
    await page.getByRole("button", { name: "Real experiment" }).click();
    await expect(page).toHaveURL(/\/experiments\/[^/]+$/);
    id = new URL(page.url()).pathname.split("/").at(-1)!;
    const original = await prisma.sample.findMany({
      where: { experimentId: id },
      orderBy: { code: "asc" },
    });
    expect(original).toHaveLength(4);
    expect(original[0].simCode).toBeTruthy();
    await prisma.experiment.update({
      where: { id },
      data: {
        metadata: {
          testPlan: {
            substrates: { count: 4 },
            groups: [{ label: "A", samples: 4, isControl: true }],
            variables: [],
            assignments: { S1: "A", S2: "A", S3: "A", S4: "A" },
          },
        },
      },
    });
    await page.reload();
    await page.getByPlaceholder("Search a person…").fill("E2E Technician");
    await page
      .getByRole("button", { name: /E2E Technician.*technician.e2e/ })
      .click();
    await expect
      .poll(
        async () =>
          (await prisma.experiment.findUniqueOrThrow({ where: { id } }))
            .assigneeId,
      )
      .not.toBeNull();
    expect(
      await prisma.sample.findMany({
        where: { experimentId: id },
        orderBy: { code: "asc" },
      }),
    ).toEqual(original);
    await page.getByRole("button", { name: "Edit test plan" }).click();
    const count = page.locator('input[type="number"][max="198"]');
    await count.fill("3");
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "Keep the existing batch size" }),
    ).toContainText("Keep the existing batch size");
    await expect(
      page.getByRole("button", { name: "Apply test plan", exact: true }),
    ).toBeDisabled();
    await count.fill("100");
    await page
      .getByRole("button", { name: "Apply test plan", exact: true })
      .click();
    await expect
      .poll(() => prisma.sample.count({ where: { experimentId: id } }))
      .toBe(100);
    const retained = await prisma.sample.findMany({
      where: { id: { in: original.map((s) => s.id) } },
      orderBy: { code: "asc" },
    });
    expect(retained.map((s) => [s.id, s.simCode])).toEqual(
      original.map((s) => [s.id, s.simCode]),
    );
    const hundred = await prisma.sample.findUniqueOrThrow({
      where: { experimentId_code: { experimentId: id, code: "S100" } },
    });
    expect(hundred.simCode).toMatch(/100$/);
    await page.goto(`/experiments/${id}/labels`);
    await expect(
      page.getByText(original[0].simCode!, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(hundred.simCode!, { exact: true }),
    ).toBeVisible();
    expect(await page.locator(".label-qr svg").count()).toBe(100);
    await page.goto(`/scan/${original[0].id}`);
    await expect(page).toHaveURL(new RegExp(`/experiments/${id}/capture`));
  } finally {
    if (id) {
      await prisma.auditEvent.deleteMany({ where: { entityId: id } });
      await prisma.notification.deleteMany({
        where: { href: { contains: id } },
      });
      await prisma.experiment.deleteMany({ where: { id } });
    }
    await prisma.$disconnect();
  }
});
