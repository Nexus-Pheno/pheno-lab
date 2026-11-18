import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { assertSafeTestDatabaseUrl } from "../../src/infrastructure/db/test-database";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
const execute = promisify(execFile);
const connection = process.env.TEST_DATABASE_URL!;
assertSafeTestDatabaseUrl({
  testDatabaseUrl: connection,
  primaryDatabaseUrl: process.env.DATABASE_URL,
  ci: process.env.CI === "true",
});
const db = new PrismaClient({ datasources: { db: { url: connection } } });
test("admin hands off the standalone client, reads the published paper, then revokes access", async ({
  page,
  request,
  baseURL,
}) => {
  const suffix = crypto.randomUUID(),
    email = "admin-" + suffix + "@example.test",
    password = "research-test-password";
  const tmp = await mkdtemp(path.join(os.tmpdir(), "pheno-reader-test-"));
  const org = await db.organization.create({
    data: { slug: "reader-" + suffix, name: "Test lab" },
  });
  const html =
    "<!doctype html><html><body>Verified synthetic bilingual paper / 合成测试</body></html>";
  const fileKey = "organizations/" + org.id + "/reports/" + suffix + ".html";
  const dir = path.join("/tmp/pheno-lab-e2e-uploads", "organizations", org.id);
  try {
    const user = await db.user.create({
      data: {
        name: "Reader admin",
        organizationId: org.id,
        role: "ADMIN",
        email,
        reportAccess: true,
        passwordHash: await bcrypt.hash(password, 4),
      },
    });
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(dir, "reports"), { recursive: true });
    await writeFile(path.join("/tmp/pheno-lab-e2e-uploads", fileKey), html);
    const paper = await db.labReport.create({
      data: {
        id: suffix,
        organizationId: org.id,
        titleEn: "Synthetic paper",
        titleZh: "测试报告",
        publicationKey: suffix,
        generatedAt: new Date(),
        storedPath: fileKey,
        contentSha256: createHash("sha256").update(html).digest("hex"),
        contentBytes: Buffer.byteLength(html),
        recipientIds: [user.id],
      },
    });
    expect((await request.get("/api/research/v1")).status()).toBe(401);
    await page.goto("/login");
    await page.locator("#email").fill(email);
    await page.locator("#password").fill(password);
    await page.locator('button[type="submit"]').click();
    await expect(page).toHaveURL(/\/$/);
    await page.goto("/profile");
    await page.getByRole("link", { name: "Research agent access" }).click();
    await page.getByLabel("Agent name").fill("Research review");
    await page.getByLabel("Include published reports").check();
    await page.getByRole("button", { name: "Create read-only key" }).click();
    const displayed = page.getByLabel("Research reader key");
    await expect(displayed).toBeVisible();
    const secret = await displayed.inputValue();
    const headers = { Authorization: "Bearer " + secret };
    const script = await request.get("/pheno_lab.py");
    expect(script.status()).toBe(200);
    await writeFile(path.join(tmp, "pheno_lab.py"), await script.body());
    // Run the unchanged downloadable CLI through its normal entry point on the
    // isolated local test app. Production builds pin the HTTPS endpoint.
    const bootstrap =
      "import pheno_lab; pheno_lab.API=" +
      JSON.stringify(baseURL + "/api/research/v1") +
      "; pheno_lab.main()";
    const run = (args: string[]) =>
      execute("python3", ["-c", bootstrap, ...args], {
        cwd: tmp,
        env: { ...process.env, PHENO_LAB_TOKEN: secret },
      });
    const catalog = JSON.parse((await run(["catalog"])).stdout);
    expect(catalog.collections).toContain("reports");
    expect(catalog.collections).not.toContain("chemistry");
    const reports = await run(["list", "reports", "--all", "--limit", "1"]);
    expect(JSON.parse(reports.stdout).id).toBe(paper.id);
    await run(["get", "report", paper.id, "--out", "report.html"]);
    expect(await readFile(path.join(tmp, "report.html"), "utf8")).toBe(html);
    expect(
      (
        await request.get("/api/research/v1?resource=chemistry", { headers })
      ).status(),
    ).toBe(403);
    expect((await request.post("/api/research/v1", { headers })).status()).toBe(
      405,
    );
    expect((await page.request.get("/api/research/v1")).status()).toBe(401);
    await page.getByRole("button", { name: "Revoke" }).click();
    await expect(page.getByText("No active keys.")).toBeVisible();
    expect((await request.get("/api/research/v1", { headers })).status()).toBe(
      401,
    );
  } finally {
    const where = { organizationId: org.id };
    await db.auditEvent.deleteMany({ where });
    await db.labReport.deleteMany({ where });
    await db.user.deleteMany({ where });
    await db.organization.delete({ where: { id: org.id } });
    await rm(tmp, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});
test.afterAll(() => db.$disconnect());
