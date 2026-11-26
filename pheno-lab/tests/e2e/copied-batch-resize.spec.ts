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
test.afterAll(() => db.$disconnect());

for (const view of [
  { width: 1440, height: 1000, lang: "en" },
  { width: 390, height: 844, lang: "zh" },
]) {
  test(`a technician resizes a copied batch and reprints labels (${view.width}, ${view.lang})`, async ({
    page,
  }, testInfo) => {
    const suffix = crypto.randomUUID();
    const orgNumber =
      Math.max(
        8000,
        (await db.organization.aggregate({ _max: { orgNumber: true } }))._max
          .orgNumber ?? 0,
      ) + 1;
    const org = await db.organization.create({
      data: {
        name: "Copied batch browser test",
        slug: `copied-batch-${suffix}`,
        orgNumber,
      },
    });
    const email = `batch-${suffix}@example.test`,
      password = "synthetic-batch-test-password";
    const user = await db.user.create({
      data: {
        organizationId: org.id,
        email,
        name: "Batch test technician",
        role: "TECHNICIAN",
        userNumber: 73,
        language: view.lang,
        passwordHash: await bcrypt.hash(password, 4),
      },
    });
    const zh = view.lang === "zh";
    const label = (en: string, cn: string) => (zh ? cn : en);
    try {
      const source = await db.experiment.create({
        data: {
          organizationId: org.id,
          createdById: user.id,
          code: `2026-${orgNumber}-73-500`,
          title: `Original batch ${suffix}`,
          status: "COMPLETE",
          metadata: {
            testPlan: {
              substrates: { count: 6 },
              groups: [{ label: "A", samples: 5, isControl: true }],
              variables: [],
              assignments: {
                S1: "A",
                S2: "A",
                S3: "A",
                S4: "A",
                S5: "A",
                S6: "ERROR",
              },
            },
          },
          samples: {
            create: Array.from({ length: 6 }, (_, i) => ({
              code: `S${i + 1}`,
              variationGroup: i === 5 ? "ERROR" : "A",
            })),
          },
          runs: { create: { runNo: 1, status: "DONE" } },
        },
      });
      const sourceSamples = await db.sample.findMany({
        where: { experimentId: source.id },
        orderBy: { code: "asc" },
      });
      await page.setViewportSize(view);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/login");
      await page.locator("#email").fill(email);
      await page.locator("#password").fill(password);
      await page.locator('button[type="submit"]').click();
      await expect(page).toHaveURL(/\/$/);
      await page
        .getByRole("button", {
          name: label("New experiment", "新建实验"),
          exact: true,
        })
        .click();
      await page
        .getByRole("button", {
          name: label("From template / previous", "从模板 / 以前的实验"),
          exact: true,
        })
        .click();
      await page
        .getByRole("dialog")
        .getByRole("button")
        .filter({ hasText: source.code })
        .click();
      await expect(page).toHaveURL(/\/experiments\/[^/]+$/);
      const id = new URL(page.url()).pathname.split("/").at(-1)!;
      expect(id).not.toBe(source.id);
      const originalCopy = await db.sample.findMany({
        where: { experimentId: id },
      });
      expect(originalCopy).toHaveLength(6);
      for (const count of [3, 8]) {
        await page
          .getByRole("button", {
            name: label("Edit test plan", "编辑实验方案"),
            exact: true,
          })
          .click();
        const editor = page.getByTestId("test-plan-editor");
        await editor
          .getByRole("spinbutton", {
            name: label("Substrates to prepare", "准备基片数量"),
            exact: true,
          })
          .fill(String(count));
        await expect(editor.getByTestId("substrate-summary")).toContainText(
          label(`Extras ${count}`, `备用 ${count}`),
        );
        const apply = editor.getByRole("button", {
          name: label("Apply test plan", "应用实验方案"),
          exact: true,
        });
        await expect(apply).toBeEnabled();
        await expect(editor).toContainText(
          label(
            "Applying replaces this copy's sample batch",
            "应用后将重建此副本的基片批次",
          ),
        );
        await apply.click();
        await expect(editor).toBeHidden();
        const samples = await db.sample.findMany({
          where: { experimentId: id },
        });
        expect(samples).toHaveLength(count);
        expect(samples.every((s) => s.variationGroup === null)).toBe(true);
        expect(
          await db.sample.findMany({
            where: { experimentId: source.id },
            orderBy: { code: "asc" },
          }),
        ).toEqual(sourceSamples);
        await page.reload();
      }
      await page
        .getByRole("button", {
          name: label("Edit test plan", "编辑实验方案"),
          exact: true,
        })
        .click();
      await page
        .getByTestId("test-plan-editor")
        .screenshot({ path: testInfo.outputPath("copied-batch-resized.png") });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.goto(`/experiments/${id}/labels`);
      expect(await page.locator(".label-qr svg").count()).toBe(8);
      for (const sample of originalCopy)
        await expect(
          page.getByText(sample.simCode!, { exact: true }),
        ).toHaveCount(0);
      const oldQr = await page.goto(`/scan/${originalCopy[0].id}`);
      expect(oldQr?.status()).toBe(404);
      const current = await db.sample.findFirstOrThrow({
        where: { experimentId: id },
      });
      await page.goto(`/scan/${current.id}`);
      await expect(page).toHaveURL(new RegExp(`/experiments/${id}/capture`));
      expect(errors).toEqual([]);
    } finally {
      await db.auditEvent.deleteMany({ where: { organizationId: org.id } });
      await db.notification.deleteMany({ where: { organizationId: org.id } });
      await db.experiment.deleteMany({ where: { organizationId: org.id } });
      await db.label.deleteMany({ where: { organizationId: org.id } });
      await db.user.deleteMany({ where: { organizationId: org.id } });
      await db.organization.delete({ where: { id: org.id } });
    }
  });
}
