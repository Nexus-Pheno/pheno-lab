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

test("capture controls keep chips dense, select Trash, confirm photo deletion, and cancel a run", async ({
  page,
}) => {
  const testDatabaseUrl = process.env.TEST_DATABASE_URL;
  if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is required");
  const prisma = new PrismaClient({
    datasources: { db: { url: testDatabaseUrl } },
  });
  let experimentId: string | undefined;
  let processId: string | undefined;
  let materialId: string | undefined;
  let runIds: string[] = [];
  try {
    const organization = await prisma.organization.findUniqueOrThrow({
      where: { slug: "e2e-org" },
    });
    const manager = await prisma.user.findUniqueOrThrow({
      where: { email: E2E_MANAGER_EMAIL },
    });
    const suffix = crypto.randomUUID();
    const process = await prisma.process.create({
      data: {
        organizationId: organization.id,
        name: `Capture controls ${suffix}`,
        kind: "PROCESSING",
        icon: "FlaskConical",
        parameters: [
          { name: "Duration", unit: "min", defaultValue: "20" },
          {
            name: "Treatment type",
            unit: "",
            defaultValue: "UV-Ozone",
          },
        ],
      },
    });
    processId = process.id;
    const material = await prisma.material.create({
      data: {
        organizationId: organization.id,
        processId: process.id,
        name: `Capture material ${suffix}`,
      },
    });
    materialId = material.id;
    const experiment = await prisma.experiment.create({
      data: {
        organizationId: organization.id,
        code: `E2E-CAP-${suffix}`,
        title: "Capture controls",
        status: "IN_LAB",
        createdById: manager.id,
        metadata: {
          testPlan: {
            groups: [
              { label: "A", samples: 4, isControl: true },
              { label: "B", samples: 1, isControl: false },
            ],
            variables: [
              {
                kind: "parameter",
                processId: process.id,
                parameter: "Duration",
                unit: "min",
                values: { A: "20", B: "30" },
              },
            ],
            assignments: {
              S1: "A",
              S2: "A",
              S3: "A",
              S4: "A",
              S5: "EXTRA",
              S6: "ERROR",
            },
          },
        },
        samples: {
          create: [
            { code: "S1", simCode: "01A01", variationGroup: "A" },
            { code: "S2", simCode: "01A02", variationGroup: "A" },
            { code: "S3", simCode: "01A03", variationGroup: "A" },
            { code: "S4", simCode: "01A04", variationGroup: "A" },
            { code: "S5", simCode: "01A05" },
            { code: "S6", simCode: "01A06", variationGroup: "ERROR" },
          ],
        },
        steps: {
          create: [
            {
              position: 0,
              processId: process.id,
              name: "Process 1",
              materials: { create: { materialId: material.id, position: 0 } },
              parameters: {
                create: [
                  {
                    position: 0,
                    name: "Duration",
                    unit: "min",
                    value: "20",
                    source: "process",
                    variations: {
                      create: [
                        { variationGroup: "A", value: "20" },
                        { variationGroup: "B", value: "30" },
                      ],
                    },
                  },
                  {
                    position: 1,
                    name: "Treatment type",
                    value: "UV-Ozone",
                    source: "process",
                  },
                  {
                    position: 2,
                    name: "Material",
                    value: material.name,
                    source: "custom",
                  },
                ],
              },
            },
            { position: 1, processId: process.id, name: "Process 2" },
            { position: 2, processId: process.id, name: "Process 3" },
            { position: 3, processId: process.id, name: "Process 4" },
          ],
        },
        runs: {
          create: [
            { runNo: 1, status: "IN_PROGRESS", technicianId: manager.id },
            { runNo: 2, status: "IN_PROGRESS", technicianId: manager.id },
          ],
        },
      },
      include: {
        samples: { orderBy: { code: "asc" } },
        steps: { orderBy: { position: "asc" } },
        runs: { orderBy: { runNo: "asc" } },
      },
    });
    experimentId = experiment.id;
    runIds = experiment.runs.map((run) => run.id);
    const [run1, run2] = experiment.runs;
    const characterization = await prisma.characterization.create({
      data: {
        experimentId: experiment.id,
        position: 0,
        processId: process.id,
        name: "Result comparison",
      },
    });
    await prisma.characterizationResult.create({
      data: {
        characterizationId: characterization.id,
        runId: run2.id,
        sampleId: experiment.samples[0].id,
        metrics: { PCE: "20" },
      },
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/login");
    await page.locator("#email").fill(E2E_MANAGER_EMAIL);
    await page.locator("#password").fill(E2E_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await expect(page).toHaveURL(/\/$/);

    const upload = await page.request.post("/api/upload", {
      multipart: {
        file: {
          name: "capture-confirmation.png",
          mimeType: "image/png",
          buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        },
      },
    });
    expect(upload.status()).toBe(200);
    const { fileName } = (await upload.json()) as { fileName: string };
    const execution = await prisma.stepExecution.create({
      data: {
        runId: run2.id,
        stepId: experiment.steps[0].id,
        sampleId: experiment.samples[0].id,
        actuals: {
          Duration: "20",
          "Treatment type": "UV-Ozone",
          Material: material.name,
        },
        materialSelections: {
          create: { parameterName: "Material", materialId: material.id },
        },
        attachments: {
          create: {
            fileName,
            storedPath: fileName,
            mime: "image/png",
            size: 8,
          },
        },
      },
      include: { attachments: true, materialSelections: true },
    });

    await page.goto(`/experiments/${experiment.id}/capture?run=${run2.id}`);
    await expect(page.locator("select")).toHaveValue(run2.id);

    await page.evaluate(() => {
      const testWindow = window as typeof window & {
        __captureSlideHistory?: string[];
      };
      testWindow.__captureSlideHistory = [];
      const buttons = Array.from(
        document.querySelectorAll<HTMLButtonElement>("[data-process-slide]"),
      );
      const record = () => {
        const active = buttons.find(
          (button) => button.getAttribute("aria-current") === "step",
        )?.dataset.processSlide;
        const history = testWindow.__captureSlideHistory!;
        if (active && history.at(-1) !== active) history.push(active);
      };
      const observer = new MutationObserver(record);
      for (const button of buttons) {
        observer.observe(button, {
          attributes: true,
          attributeFilter: ["aria-current"],
        });
      }
    });
    await page.locator('[data-process-slide="3"]').click();
    await expect(page.locator('[data-process-slide="3"]')).toHaveAttribute(
      "aria-current",
      "step",
    );
    await expect
      .poll(() =>
        page.locator("[data-capture-track]").evaluate((element) => {
          const track = element as HTMLElement;
          return Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
        }),
      )
      .toBe(3);
    expect(
      await page.evaluate(
        () =>
          (window as typeof window & { __captureSlideHistory?: string[] })
            .__captureSlideHistory,
      ),
    ).toEqual(["3"]);
    await page.locator('[data-process-slide="0"]').click();
    await expect
      .poll(() =>
        page.locator("[data-capture-track]").evaluate((element) => {
          const track = element as HTMLElement;
          return Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
        }),
      )
      .toBe(0);

    await page.getByRole("button", { name: "Edit capture" }).click();
    await expect(
      page.locator('[data-capture-field="Duration"]'),
    ).toHaveAttribute("data-capture-kind", "text");
    await expect(
      page.locator('[data-capture-field="Treatment type"]'),
    ).toHaveAttribute("data-capture-kind", "select");
    await expect(
      page.locator('[data-capture-field="Material"]'),
    ).toHaveAttribute("data-capture-kind", "material");
    await expect(page.locator('[data-capture-field="Material"]')).toHaveValue(
      material.id,
    );

    const firstStepCard = page.locator("[data-capture-track] > div").first();
    const firstThree = await Promise.all(
      ["S1", "S2", "S3"].map((code) =>
        firstStepCard
          .locator(`[data-substrate-sample="${code}"]`)
          .boundingBox(),
      ),
    );
    expect(firstThree.every(Boolean)).toBe(true);
    expect(
      firstThree.every((box) => box && Math.abs(box.y - firstThree[0]!.y) < 2),
    ).toBe(true);

    await firstStepCard.locator('[data-substrate-sample="S1"]').click();
    await firstStepCard.locator('[data-substrate-sample="S6"]').click();
    await expect(
      page.getByRole("button", { name: /Confirm for S6 \(1\)/ }),
    ).toBeVisible();

    await firstStepCard
      .locator('input[type="file"]')
      .first()
      .setInputFiles({
        name: "pending-capture.png",
        mimeType: "image/png",
        buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      });
    const pendingDelete = page.getByRole("button", { name: "Delete photo?" });
    await expect(pendingDelete).toBeVisible();
    const [deleteBox, stripBox] = await Promise.all([
      pendingDelete.boundingBox(),
      page.locator("[data-pending-photo-strip]").boundingBox(),
    ]);
    expect(deleteBox).toBeTruthy();
    expect(stripBox).toBeTruthy();
    expect(deleteBox!.y).toBeGreaterThanOrEqual(stripBox!.y - 0.5);
    expect(deleteBox!.x + deleteBox!.width).toBeLessThanOrEqual(
      stripBox!.x + stripBox!.width + 0.5,
    );

    await page.reload();
    await expect(page.locator("select").first()).toHaveValue(run2.id);
    await page.getByRole("button", { name: /Photos \(1\)/ }).click();
    await page.getByRole("button", { name: "Delete photo?" }).click();
    await expect(
      page.getByText("Delete photo?", { exact: true }),
    ).toBeVisible();
    expect(
      await prisma.attachment.count({
        where: { stepExecutionId: execution.id },
      }),
    ).toBe(1);
    await page.getByRole("button", { name: "Cancel" }).click();
    expect(
      await prisma.attachment.count({
        where: { stepExecutionId: execution.id },
      }),
    ).toBe(1);
    await page.getByRole("button", { name: "Close" }).click();

    await page.goto(`/experiments/${experiment.id}/results`);
    const emptyGroupRows = page.locator(
      '[data-result-group="B"][data-empty-group="true"]',
    );
    await expect(emptyGroupRows).toHaveCount(2);
    await expect(emptyGroupRows.first()).toContainText("—");
    await expect(emptyGroupRows.nth(1)).toContainText("—");
    await expect(page.getByText("ERROR", { exact: true })).toHaveCount(0);

    await page.goto(`/experiments/${experiment.id}/capture?run=${run2.id}`);
    await expect(page.locator("select").first()).toHaveValue(run2.id);

    await page.getByRole("button", { name: "Delete current run" }).click();
    await expect(
      page.getByText("Delete Run 2?", { exact: true }),
    ).toBeVisible();
    expect(
      await prisma.run.findUniqueOrThrow({ where: { id: run2.id } }),
    ).toMatchObject({ status: "IN_PROGRESS" });
    await page.getByRole("button", { name: "Confirm delete run" }).click();
    await expect(page).toHaveURL(
      new RegExp(`/experiments/${experiment.id}/capture\\?run=${run1.id}`),
    );
    await expect(page.locator("select").first()).toHaveValue(run1.id);
    await expect
      .poll(() =>
        prisma.run
          .findUniqueOrThrow({ where: { id: run2.id } })
          .then((run) => run.status),
      )
      .toBe("CANCELLED");
  } finally {
    if (experimentId) {
      await prisma.auditEvent.deleteMany({
        where: { entityId: { in: [experimentId, ...runIds] } },
      });
      await prisma.experiment.deleteMany({ where: { id: experimentId } });
    }
    if (materialId) {
      await prisma.material.deleteMany({ where: { id: materialId } });
    }
    if (processId) {
      await prisma.process.deleteMany({ where: { id: processId } });
    }
    await prisma.$disconnect();
  }
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
