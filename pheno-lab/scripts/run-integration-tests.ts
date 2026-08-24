import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
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
    "vitest",
    "run",
    "--config",
    "vitest.integration.config.mts",
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_URL: testDatabaseUrl,
      NODE_ENV: "test",
      SESSION_SECRET:
        process.env.SESSION_SECRET ??
        "integration-test-session-secret-over-32-characters",
      STORAGE_DRIVER: "local",
      UPLOAD_DIR:
        process.env.TEST_UPLOAD_DIR ??
        path.join(os.tmpdir(), "pheno-lab-integration-uploads"),
    },
  },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
