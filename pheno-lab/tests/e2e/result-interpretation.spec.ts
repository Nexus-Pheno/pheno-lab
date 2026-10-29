import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { E2E_MANAGER_EMAIL, E2E_PASSWORD } from "./global-setup";

let db: PrismaClient;
let experimentId: string;
let processId: string;
test.beforeAll(async () => {
  db = new PrismaClient({
    datasources: { db: { url: process.env.TEST_DATABASE_URL } },
  });
  const owner = await db.user.findUniqueOrThrow({
    where: { email: E2E_MANAGER_EMAIL },
  });
  const fixtureProcess = await db.process.create({
    data: {
      organizationId: owner.organizationId,
      name: `Interpretation ${crypto.randomUUID()}`,
      kind: "PROCESSING",
      icon: "FlaskConical",
    },
  });
  processId = fixtureProcess.id;
  const exp = await db.experiment.create({
    data: {
      organizationId: owner.organizationId,
      createdById: owner.id,
      code: `E2E-INTERPRET-${crypto.randomUUID().slice(0, 8)}`,
      title: "Synthetic passivant screening",
      status: "IN_LAB",
      problem: "Which passivant improves useful output over untreated devices?",
      metadata: {
        testPlan: {
          groups: [
            { label: "A", isControl: true },
            { label: "C", isControl: false },
            { label: "H", isControl: false },
          ],
          variables: [
            {
              kind: "parameter",
              processId,
              layer: "PASS_TOP",
              parameter: "Passivation material",
              unit: "",
              values: { A: "Reference", C: "Candidate X", H: "/" },
            },
            {
              kind: "parameter",
              processId,
              layer: "PASS_TOP",
              parameter: "Concentration",
              unit: "mg/mL",
              values: { A: "0.2", C: "0.4", H: "/" },
            },
          ],
        },
        aiSummary: {
          text: "Earlier advisory note",
          lang: "en",
          model: "synthetic",
          generatedAt: "2026-01-01T00:00:00Z",
          analysis: {
            purpose: {
              en: "Compare Candidate X with the untreated reference.",
              zh: "比较候选材料X与未处理参照。",
            },
            objectiveAttainment: {
              en: "Candidate X improves output. Retain it for a fixed-condition repeat.",
              zh: "候选材料X提高了输出。保留该条件，固定工艺复验。",
            },
            groups: [
              {
                group: "C",
                judgment: {
                  en: "Candidate X has improvement potential.",
                  zh: "候选材料X具有增效潜力。",
                },
                mainIssue: {
                  en: "Only two devices were measured; test consistency next.",
                  zh: "目前只有两片器件，下一轮重点确认一致性。",
                },
                nextTest: {
                  en: "Repeat C and H with the same coating conditions.",
                  zh: "固定涂布条件，配对复验C与H。",
                },
                mechanisms: [
                  {
                    en: "Uneven deposition may explain the spread.",
                    zh: "沉积不均匀可能造成波动。",
                  },
                ],
                expectedOutcome: {
                  en: "Look for repeated gains with a narrower spread.",
                  zh: "观察增效能否重复，同时减小波动。",
                },
                decision: {
                  en: "Continue if the gain repeats; otherwise check deposition.",
                  zh: "若增效重复出现则继续；否则先排查沉积。",
                },
              },
            ],
          },
        },
      },
      samples: {
        create: [
          { code: "S1", variationGroup: "C" },
          { code: "S2", variationGroup: "C" },
          { code: "S3", variationGroup: "H" },
          { code: "S4", variationGroup: "H" },
          { code: "S5", variationGroup: "A" },
          { code: "S6", variationGroup: "ERROR" },
        ],
      },
      steps: {
        create: {
          name: "Top passivation",
          position: 0,
          layer: "PASS_TOP",
          processId,
          parameters: {
            create: [
              {
                name: "Passivation material",
                position: 0,
                value: "Reference",
                variations: {
                  create: [
                    { variationGroup: "A", value: "Reference" },
                    { variationGroup: "C", value: "Candidate X" },
                    { variationGroup: "H", value: "/" },
                  ],
                },
              },
              {
                name: "Concentration",
                position: 1,
                value: "0.2",
                unit: "mg/mL",
                variations: {
                  create: [
                    { variationGroup: "A", value: "0.2" },
                    { variationGroup: "C", value: "0.4" },
                    { variationGroup: "H", value: "/" },
                  ],
                },
              },
            ],
          },
        },
      },
      characterizations: {
        create: { name: "J-V synthetic", position: 0, processId },
      },
    },
    include: { samples: true, characterizations: true },
  });
  experimentId = exp.id;
  const latest = new Date();
  for (const [index, value] of [19.1, 20.6, 18.9, 19, 19.2, 49].entries()) {
    const sample = exp.samples.find((s) => s.code === `S${index + 1}`)!;
    await db.characterizationResult.create({
      data: {
        characterizationId: exp.characterizations[0].id,
        sampleId: sample.id,
        capturedAt: latest,
        metrics: {
          "PCE (%)": String(value),
          "Voc (V)": "1.12",
          "Jsc (mA/cm²)": "22.1",
          "FF (%)": "77.2",
        },
      },
    });
  }
  await db.characterizationResult.create({
    data: {
      characterizationId: exp.characterizations[0].id,
      sampleId: exp.samples.find((s) => s.code === "S1")!.id,
      capturedAt: new Date(latest.getTime() - 10000),
      metrics: { "PCE (%)": "17" },
    },
  });
});
test.afterAll(async () => {
  if (experimentId) await db.experiment.delete({ where: { id: experimentId } });
  if (processId) await db.process.delete({ where: { id: processId } });
  await db?.$disconnect();
});
for (const width of [390, 1440]) {
  for (const lang of ["en", "zh"] as const) {
    test(`readable conditions, shared samples and interim AI at ${width}px ${lang}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto("/login");
      await page.locator("#email").fill(E2E_MANAGER_EMAIL);
      await page.locator("#password").fill(E2E_PASSWORD);
      await page.locator('button[type="submit"]').click();
      await expect(page).toHaveURL(/\/$/);
      await page
        .context()
        .addCookies([
          { name: "pheno_lang", value: lang, domain: "127.0.0.1", path: "/" },
        ]);
      await page.goto(`/experiments/${experimentId}/results`);
      await expect(page.locator("#analysis-reference")).toHaveValue("H");
      await expect(page.locator("[data-reference-warning]")).toBeVisible();
      const group = page.locator('[data-analysis-group="C"]');
      await expect(group).toContainText("Candidate X");
      await expect(group).toContainText("0.4 mg/mL");
      await expect(
        group.locator('[data-screening-judgment="PROMISING_VARIABLE"]'),
      ).toBeVisible();
      await expect(group).toContainText("19.85");
      await expect(group).toContainText("+1.6");
      const table = page.locator("[data-result-comparison]");
      await expect(table.locator("[data-result-sample]")).toHaveCount(5);
      await expect(table.locator('[data-result-sample="S1"]')).toContainText(
        "19.1",
      );
      const ai = page.locator("[data-ai-result-analysis]");
      await expect(ai).toBeVisible();
      await expect(ai.locator("[data-ai-stale]")).toBeVisible();
      await expect(ai).toContainText(
        lang === "en"
          ? "Draft · researcher review needed"
          : "草稿 · 待研究人员核对",
      );
      await expect(ai.locator("[data-ai-result-overview]")).toContainText(
        lang === "en"
          ? "Candidate X improves output. Retain it for a fixed-condition repeat."
          : "候选材料X提高了输出。保留该条件，固定工艺复验。",
      );
      const aiGroup = ai.locator('[data-ai-group="C"]');
      await expect(aiGroup.locator("[data-ai-judgment]")).toBeVisible();
      await expect(aiGroup.locator("[data-ai-issue]")).toBeVisible();
      await expect(aiGroup.locator("[data-ai-next]")).toBeVisible();
      expect(
        await aiGroup.evaluate((element) => {
          const ordered = [
            "[data-ai-judgment]",
            "[data-ai-issue]",
            "[data-ai-next]",
            "[data-ai-reasoning]",
          ].map((selector) => element.querySelector(selector)!);
          return ordered.every(
            (node, index) =>
              index === 0 ||
              Boolean(
                ordered[index - 1].compareDocumentPosition(node) &
                Node.DOCUMENT_POSITION_FOLLOWING,
              ),
          );
        }),
      ).toBe(true);
      const context = ai.locator("[data-ai-context]");
      await expect(context).not.toHaveAttribute("open");
      await expect(
        context.getByText(
          lang === "en"
            ? "Compare Candidate X with the untreated reference."
            : "比较候选材料X与未处理参照。",
        ),
      ).not.toBeVisible();
      await context.locator("summary").click();
      await expect(context).toHaveAttribute("open");
      await expect(
        context.getByText(
          lang === "en"
            ? "Compare Candidate X with the untreated reference."
            : "比较候选材料X与未处理参照。",
        ),
      ).toBeVisible();
      await context.locator("summary").click();
      await expect(
        ai.getByRole("button", {
          name: lang === "en" ? "Regenerate analysis" : "重新生成分析",
          exact: true,
        }),
      ).toBeEnabled();
      await page.locator("#analysis-reference").selectOption("A");
      await page
        .getByRole("button", {
          name: lang === "en" ? "Compare" : "比较",
          exact: true,
        })
        .click();
      await expect(page).toHaveURL(/reference=A/);
      await expect(page.locator("#analysis-reference")).toHaveValue("A");
      await expect(ai.locator("[data-ai-result-overview]")).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect(errors).toEqual([]);
      await ai.screenshot({
        path: `test-results/result-interpretation-ai-${lang}-${width}.png`,
      });
      await page.screenshot({
        path: `test-results/result-interpretation-${lang}-${width}.png`,
        fullPage: true,
      });
    });
  }
}
