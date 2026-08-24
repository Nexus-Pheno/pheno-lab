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
  [
    packageManager,
    "exec",
    "prisma",
    "migrate",
    "diff",
    "--from-url",
    testDatabaseUrl,
    "--to-schema-datamodel",
    "prisma/schema.prisma",
    "--exit-code",
  ],
  { stdio: "inherit", env: process.env },
);

if (result.error) throw result.error;
if (result.status === 2) {
  console.error(
    "Prisma schema drift detected: committed migrations are incomplete.",
  );
}
process.exit(result.status ?? 1);
