import { spawnSync } from "node:child_process";
import { assertSafeTestDatabaseUrl } from "../src/infrastructure/db/test-database";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is required");

assertSafeTestDatabaseUrl({
  testDatabaseUrl,
  primaryDatabaseUrl: process.env.DATABASE_URL,
  ci: process.env.CI === "true",
});

const packageManager = process.env.npm_execpath;
if (!packageManager) throw new Error("Run this script through pnpm");

const result = spawnSync(
  process.execPath,
  [packageManager, "exec", "prisma", "migrate", "deploy"],
  {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: testDatabaseUrl, NODE_ENV: "test" },
  },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
