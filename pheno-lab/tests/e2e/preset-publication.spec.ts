import { expect, test, type Page } from "@playwright/test";
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
const password = "synthetic-preset-browser-password";

async function fixture(lang: "en" | "zh") {
  const suffix = crypto.randomUUID();
  const org = await db.organization.create({
    data: { name: "Preset browser fixture", slug: `preset-browser-${suffix}` },
  });
  const passwordHash = await bcrypt.hash(password, 4);
  const users = [];
  for (const [tag, role] of [
    ["author", "TECHNICIAN"],
    ["other", "TECHNICIAN"],
    ["reviewer", "MANAGER"],
  ] as const) {
    users.push(
      await db.user.create({
        data: {
          organizationId: org.id,
          email: `preset-${tag}-${suffix}@example.test`,
          name: `Preset ${tag}`,
          role,
          passwordHash,
          language: lang,
        },
      }),
    );
  }
  const [author, other, reviewer] = users;
  const process = await db.process.create({
    data: {
      organizationId: org.id,
      name: "Browser preset process",
      kind: "PROCESSING",
    },
  });
  const experiment = await db.experiment.create({
    data: {
      organizationId: org.id,
      createdById: author.id,
      assigneeId: other.id,
      code: `PRESET-${suffix}`,
      title: "Preset browser experiment",
      steps: {
        create: {
          name: "Browser preset step",
          processId: process.id,
          position: 0,
          parameters: {
            create: {
              position: 0,
              name: "Browser temperature",
              unit: "C",
              value: "100",
              source: "custom",
            },
          },
        },
      },
    },
    include: { steps: true },
  });
  return {
    org,
    author,
    other,
    reviewer,
    experiment,
    async cleanup() {
      const where = { organizationId: org.id };
      await db.presetPublicationRequest.deleteMany({ where });
      await db.personalPreset.deleteMany({ where });
      await db.preset.deleteMany({ where });
      await db.notification.deleteMany({ where });
      await db.auditEvent.deleteMany({ where });
      await db.experiment.deleteMany({ where });
      await db.label.deleteMany({ where });
      await db.process.deleteMany({ where });
      await db.user.deleteMany({ where });
      await db.organization.delete({ where: { id: org.id } });
    },
  };
}

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/$/);
}

test.afterAll(() => db.$disconnect());
test.use({ actionTimeout: 15_000 });
test("characterization preset editing validates setting names and preserves private changes until approval", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(60_000);
  const f = await fixture("en");
  const reviewer = await browser.newPage({
    baseURL: testInfo.project.use.baseURL,
  });
  try {
    const process = await db.process.create({
      data: {
        organizationId: f.org.id,
        name: "Browser characterization process",
        kind: "CHARACTERIZATION",
      },
    });
    const preset = await db.personalPreset.create({
      data: {
        organizationId: f.org.id,
        ownerId: f.author.id,
        processId: process.id,
        kind: "CHARACTERIZATION",
        name: "Browser characterization preset",
        payload: {
          equipmentId: null,
          environmentId: null,
          environmentConditions: { Temperature: "25" },
          settings: { Duration: "30" },
          sampleScope: "all",
        },
      },
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, f.author.email);
    await page.goto("/library#presets");
    const section = page.locator("#presets");
    await section.getByRole("tab", { name: /My presets/ }).click();
    const row = section.locator(`[data-preset-id="personal:${preset.id}"]`);
    await row.getByRole("button", { name: "Edit", exact: true }).click();
    const settings = row.getByRole("group", { name: "Settings", exact: true });
    await settings.getByLabel("Settings Value 1", { exact: true }).fill("60");
    await row.getByLabel("Sample scope", { exact: true }).fill("per-group");
    await settings
      .getByRole("button", { name: "Add row", exact: true })
      .click();
    await settings
      .getByLabel("Settings Name 2", { exact: true })
      .fill("Duration");
    await row
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(row.getByRole("alert")).toHaveText(
      "Each setting needs a non-empty, unique name.",
    );
    expect(
      (await db.personalPreset.findUniqueOrThrow({ where: { id: preset.id } }))
        .version,
    ).toBe(1);
    await settings
      .getByRole("button", { name: "Remove row 2", exact: true })
      .click();
    await expect(row.getByRole("alert")).toHaveCount(0);
    await row.screenshot({
      path: testInfo.outputPath("characterization-editor-mobile.png"),
    });
    expect(await row.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
      true,
    );
    await row
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(
      row.getByRole("button", { name: "Save changes", exact: true }),
    ).toHaveCount(0);
    const updated = await db.personalPreset.findUniqueOrThrow({
      where: { id: preset.id },
    });
    expect(updated.payload).toMatchObject({
      environmentConditions: { Temperature: "25" },
      settings: { Duration: "60" },
      sampleScope: "per-group",
    });
    expect(await db.preset.count({ where: { organizationId: f.org.id } })).toBe(
      0,
    );
    await row
      .getByRole("button", { name: "Submit for publication", exact: true })
      .click();
    await expect(row).toContainText("Pending review");
    await login(reviewer, f.reviewer.email);
    await reviewer.goto("/library#presets");
    await reviewer
      .locator("#presets")
      .getByRole("tab", { name: /Publication reviews/ })
      .click();
    const proposal = reviewer.locator("[data-preset-review-id]");
    await proposal.locator("summary").click();
    await expect(proposal).toContainText("Browser characterization process");
    await expect(proposal).toContainText("60");
    await proposal
      .getByRole("button", { name: "Approve and publish", exact: true })
      .click();
    await expect(proposal).toHaveCount(0);
    await expect
      .poll(() =>
        db.preset.count({
          where: { organizationId: f.org.id, kind: "CHARACTERIZATION" },
        }),
      )
      .toBe(1);
    expect(
      (
        await db.preset.findFirstOrThrow({
          where: { organizationId: f.org.id },
        })
      ).payload,
    ).toEqual(updated.payload);
  } finally {
    await reviewer.close();
    await f.cleanup();
  }
});
for (const view of [
  { width: 1440, height: 1000, lang: "en" as const },
  { width: 390, height: 844, lang: "zh" as const },
]) {
  test(`personal presets require publication review and preserve the public version (${view.width}px ${view.lang})`, async ({
    page,
    browser,
  }, testInfo) => {
    test.setTimeout(120_000);
    const f = await fixture(view.lang);
    const reviewer = await browser.newPage({
      baseURL: testInfo.project.use.baseURL,
      viewport: view,
    });
    const other = await browser.newPage({
      baseURL: testInfo.project.use.baseURL,
      viewport: view,
    });
    const errors: string[] = [];
    for (const p of [page, reviewer, other])
      p.on("pageerror", (e) => errors.push(e.message));
    const zh = view.lang === "zh";
    const label = (en: string, cn: string) => (zh ? cn : en);
    const name = "Browser personal preset";
    const revisedName = "Browser revised preset";
    const section = page.locator("#presets");
    const reviewSection = reviewer.locator("#presets");
    const otherSection = other.locator("#presets");
    try {
      await page.setViewportSize(view);
      await login(page, f.author.email);
      await page.goto(`/experiments/${f.experiment.id}`);
      await page
        .locator(`[data-drop-step="${f.experiment.steps[0].id}"]`)
        .click();
      page.once("dialog", (dialog) => dialog.accept(name));
      await page
        .getByRole("button", {
          name: label("Save as preset", "保存为预设"),
          exact: true,
        })
        .click();
      await expect
        .poll(() =>
          db.personalPreset.count({ where: { organizationId: f.org.id } }),
        )
        .toBe(1);
      expect(
        await db.preset.count({ where: { organizationId: f.org.id } }),
      ).toBe(0);
      const personal = await db.personalPreset.findFirstOrThrow({
        where: { organizationId: f.org.id },
      });
      const privateId = `personal:${personal.id}`;
      await expect(page.locator(`option[value="${privateId}"]`)).toContainText(
        label("Personal", "个人"),
      );
      await page.goto("/library#presets");
      await section
        .getByRole("tab", { name: new RegExp(label("My presets", "我的预设")) })
        .click();
      let row = section.locator(`[data-preset-id="${privateId}"]`);
      await expect(row).toContainText(name);
      await row
        .getByRole("button", { name: label("Delete", "删除"), exact: true })
        .click();
      await row
        .getByRole("button", { name: label("Cancel", "取消"), exact: true })
        .click();
      await expect(row).toBeVisible();
      await login(other, f.other.email);
      await other.goto("/library#presets");
      await expect(otherSection).not.toContainText(name);
      await row
        .getByRole("button", {
          name: label("Submit for publication", "提交公开审核"),
          exact: true,
        })
        .click();
      await expect(row).toContainText(label("Pending review", "待审核"));
      await login(reviewer, f.reviewer.email);
      await reviewer.goto("/library#presets");
      await reviewSection
        .getByRole("tab", {
          name: new RegExp(label("Publication reviews", "公开审核")),
        })
        .click();
      let proposal = reviewSection
        .locator("[data-preset-review-id]")
        .filter({ hasText: name });
      await proposal.locator("summary").click();
      await expect(proposal).toContainText("100 C");
      await expect(
        proposal.getByRole("button", {
          name: label("Reject", "拒绝"),
          exact: true,
        }),
      ).toBeDisabled();
      await proposal
        .getByRole("button", {
          name: label("Approve and publish", "通过并公开"),
          exact: true,
        })
        .click();
      await expect
        .poll(() => db.preset.count({ where: { organizationId: f.org.id } }))
        .toBe(1);
      const published = await db.preset.findFirstOrThrow({
        where: { organizationId: f.org.id },
      });
      await other.reload();
      await expect(otherSection).toContainText(name);
      await expect(
        otherSection.getByRole("button", {
          name: label("Edit", "编辑"),
          exact: true,
        }),
      ).toHaveCount(0);
      await page.reload();
      await section
        .getByRole("tab", { name: new RegExp(label("My presets", "我的预设")) })
        .click();
      row = section.locator(`[data-preset-id="${privateId}"]`);
      await row
        .getByRole("button", { name: label("Edit", "编辑"), exact: true })
        .click();
      await row
        .getByLabel(label("Preset name", "预设名称"), { exact: true })
        .fill(revisedName);
      await row
        .getByLabel(label("Value 1", "数值 1"), { exact: true })
        .fill("200");
      await row
        .getByRole("button", {
          name: label("Save changes", "保存更改"),
          exact: true,
        })
        .click();
      await expect(row.getByRole("heading")).toHaveText(revisedName);
      await other.reload();
      await expect(otherSection).toContainText(name);
      await expect(otherSection).not.toContainText(revisedName);
      await row
        .getByRole("button", {
          name: label("Submit for publication", "提交公开审核"),
          exact: true,
        })
        .click();
      await expect(row).toContainText(label("Pending review", "待审核"));
      await reviewer.reload();
      await reviewSection
        .getByRole("tab", {
          name: new RegExp(label("Publication reviews", "公开审核")),
        })
        .click();
      proposal = reviewSection
        .locator("[data-preset-review-id]")
        .filter({ hasText: revisedName });
      await proposal.locator("summary").click();
      await expect(proposal).toContainText("100 C");
      await expect(proposal).toContainText("200 C");
      await proposal.getByRole("textbox").fill("Verify the new setting");
      await proposal
        .getByRole("button", { name: label("Reject", "拒绝"), exact: true })
        .click();
      await expect(proposal).toHaveCount(0);
      await page.reload();
      await section
        .getByRole("tab", { name: new RegExp(label("My presets", "我的预设")) })
        .click();
      await row
        .getByRole("button", {
          name: label("Submit for publication", "提交公开审核"),
          exact: true,
        })
        .click();
      await expect(row).toContainText(label("Pending review", "待审核"));
      await reviewer.reload();
      await reviewSection
        .getByRole("tab", {
          name: new RegExp(label("Publication reviews", "公开审核")),
        })
        .click();
      proposal = reviewSection
        .locator("[data-preset-review-id]")
        .filter({ hasText: revisedName });
      await proposal.locator("summary").click();
      await proposal.screenshot({
        path: testInfo.outputPath("preset-review.png"),
      });
      expect(
        await reviewSection.evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
      await proposal
        .getByRole("button", {
          name: label("Approve and publish", "通过并公开"),
          exact: true,
        })
        .click();
      await expect
        .poll(
          async () =>
            (await db.preset.findUniqueOrThrow({ where: { id: published.id } }))
              .name,
        )
        .toBe(revisedName);
      expect(
        await db.preset.count({ where: { organizationId: f.org.id } }),
      ).toBe(1);
      await page.reload();
      await section
        .getByRole("tab", { name: new RegExp(label("My presets", "我的预设")) })
        .click();
      await row
        .getByRole("button", { name: label("Delete", "删除"), exact: true })
        .click();
      await row
        .getByRole("button", {
          name: label("Confirm deletion", "确认删除"),
          exact: true,
        })
        .click();
      await expect(row).toHaveCount(0);
      expect(
        await db.preset.findUnique({ where: { id: published.id } }),
      ).not.toBeNull();
      await reviewer.reload();
      const publicRow = reviewSection.locator(
        `[data-preset-id="${published.id}"]`,
      );
      await publicRow
        .getByRole("button", { name: label("Edit", "编辑"), exact: true })
        .click();
      await publicRow
        .getByLabel(label("Preset name", "预设名称"), { exact: true })
        .fill("Manager corrected preset");
      await publicRow
        .getByRole("button", {
          name: label("Save changes", "保存更改"),
          exact: true,
        })
        .click();
      await expect(publicRow.getByRole("heading")).toHaveText(
        "Manager corrected preset",
      );
      await publicRow
        .getByRole("button", { name: label("Delete", "删除"), exact: true })
        .click();
      await publicRow
        .getByRole("button", {
          name: label("Confirm deletion", "确认删除"),
          exact: true,
        })
        .click();
      await expect(publicRow).toHaveCount(0);
      await other.reload();
      await expect(otherSection.locator("[data-preset-id]")).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally {
      await reviewer.close();
      await other.close();
      await f.cleanup();
    }
  });
}
