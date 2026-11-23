import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { assertSafeTestDatabaseUrl } from "../../src/infrastructure/db/test-database";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
const connection = process.env.TEST_DATABASE_URL!;
assertSafeTestDatabaseUrl({
  testDatabaseUrl: connection,
  primaryDatabaseUrl: process.env.DATABASE_URL,
  ci: process.env.CI === "true",
});
const db = new PrismaClient({ datasources: { db: { url: connection } } });
test("bilingual method picker and original-file upload reach the downloaded MCP reader", async ({
  page,
  request,
  baseURL,
}) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "film-study-e2e-"));
  const tag = randomUUID(),
    email = tag + "@example.test",
    pw = "film-test-password";
  const org = await db.organization.create({
    data: { slug: tag, name: "Test lab" },
  });
  try {
    await db.user.create({
      data: {
        email,
        passwordHash: await bcrypt.hash(pw, 4),
        name: "Test uploader",
        organizationId: org.id,
        role: "TECHNICIAN",
        filmStudyAccess: true,
      },
    });
    const owner = await db.user.create({
      data: {
        email: "reader-" + email,
        passwordHash: "test",
        name: "Reader",
        organizationId: org.id,
        role: "ADMIN",
        filmStudyAgentAccess: true,
      },
    });
    const bearer = "phr_" + randomBytes(32).toString("base64url");
    await db.researchReaderKey.create({
      data: {
        organizationId: org.id,
        userId: owner.id,
        sessionVersion: owner.sessionVersion,
        label: "fixture",
        digest: createHash("sha256").update(bearer).digest("hex"),
        expiresAt: new Date(Date.now() + 600000),
        filmStudies: true,
      },
    });
    const mat = await db.material.create({
      data: { organizationId: org.id, name: "Synthetic substrate" },
    });
    await page.goto("/login");
    await page.locator("#email").fill(email);
    await page.locator("#password").fill(pw);
    await page.locator('button[type="submit"]').click();
    await expect(page).toHaveURL(/\/$/);
    await page
      .getByRole("link", { name: "Characterizations", exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "Characterization method" })
      .fill("开尔文探针力");
    await page.getByRole("option", { name: /KPFM/ }).click();
    await page.getByLabel("Library materials").fill(mat.name);
    await page
      .getByLabel("Materials and lab notes")
      .fill("Coupon A, film on glass. Map acquired at room temperature.");
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 51, 0xb1);
    await page.getByLabel("Original files").setInputFiles([
      { name: "薄膜.spm", mimeType: "application/octet-stream", buffer: bytes },
      {
        name: "settings.csv",
        mimeType: "text/csv",
        buffer: Buffer.from("gain,2"),
      },
    ]);
    let interrupt = true;
    const uploaded: string[] = [];
    await page.route("**/api/film-studies/files/**", async (route) => {
      const req = route.request();
      if (req.method() === "PUT") {
        uploaded.push(req.url());
        if (interrupt && new URL(req.url()).searchParams.get("part") === "1") {
          interrupt = false;
          await route.abort();
          return;
        }
      }
      await route.continue();
    });
    await page
      .getByRole("button", { name: "Save characterization", exact: true })
      .click();
    await expect(page.locator("main").getByRole("alert")).toContainText(
      "Upload interrupted",
    );
    const firstPart = uploaded[0];
    await page
      .getByRole("button", { name: "Save characterization", exact: true })
      .click();
    await expect(page.getByText("Saved characterizations (1)")).toBeVisible();
    await page.locator("summary").filter({ hasText: "KPFM" }).click();
    expect(uploaded.filter((url) => url === firstPart)).toHaveLength(1);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page
        .locator("main")
        .evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
    ).toBe(true);
    const href = await page
      .getByRole("link", { name: "薄膜.spm" })
      .getAttribute("href");
    const binary = await page.request.get(href!);
    expect(await binary.body()).toEqual(bytes);
    expect(binary.headers()["content-disposition"]).toContain("attachment");
    const script = await request.get("/pheno_lab.py");
    expect(script.ok()).toBe(true);
    await writeFile(path.join(tmp, "pheno_lab.py"), await script.body());
    const fileId = href!.split("/").pop();
    const messages =
      [
        {
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "fixture", version: "1" },
          },
        },
        { method: "notifications/initialized" },
        { id: 2, method: "tools/list" },
        {
          id: 3,
          method: "tools/call",
          params: {
            name: "search_characterizations",
            arguments: { q: "开尔文" },
          },
        },
        {
          id: 4,
          method: "tools/call",
          params: {
            name: "download_characterization_file",
            arguments: { fileId },
          },
        },
      ]
        .map((m) => JSON.stringify({ jsonrpc: "2.0", ...m }))
        .join("\n") + "\n";
    await writeFile(path.join(tmp, "requests.jsonl"), messages);
    const bootstrap =
      "import pheno_lab,sys; pheno_lab.API=" +
      JSON.stringify(baseURL + "/api/research/v1") +
      "; sys.stdin=open('requests.jsonl');pheno_lab.main()";
    const res = await execute("python3", ["-c", bootstrap, "mcp"], {
      cwd: tmp,
      env: {
        ...process.env,
        PHENO_LAB_TOKEN: bearer,
        PHENO_LAB_DOWNLOAD_DIR: tmp,
      },
    });
    const replies = res.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(replies.map((r) => r.id)).toEqual([1, 2, 3, 4]);
    expect(replies[1].result.tools.length).toBe(2);
    const rows = JSON.parse(replies[2].result.content[0].text).data;
    expect(rows[0].method).toBe("KPFM");
    expect(rows[0].materials[0].id).toBe(mat.id);
    expect(rows[0].interpretation).toBeNull();
    const downloaded = JSON.parse(replies[3].result.content[0].text);
    expect(await readFile(downloaded.path)).toEqual(bytes);
  } finally {
    const where = { organizationId: org.id };
    await db.auditEvent.deleteMany({ where });
    await db.filmStudy.deleteMany({ where });
    await db.material.deleteMany({ where });
    await db.user.deleteMany({ where });
    await db.organization.delete({ where: { id: org.id } });
    await rm(tmp, { recursive: true, force: true });
    await rm(path.join("/tmp/pheno-lab-e2e-uploads", "organizations", org.id), {
      recursive: true,
      force: true,
    });
    await db.$disconnect();
  }
});
