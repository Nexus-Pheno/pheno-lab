import { defineConfig, devices } from "@playwright/test";

const port = 3467;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `pnpm start -H 127.0.0.1 -p ${port}`,
    url: `${baseURL}/api/health/live`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      NODE_ENV: "production",
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        "postgresql://127.0.0.1:5432/pheno_lab_test",
      SESSION_SECRET: "e2e-session-secret-with-more-than-32-random-characters",
      SESSION_COOKIE_SECURE: "false",
      INGEST_CRON_SECRET: "e2e-ingest-secret-with-enough-random-characters",
      HEALTHCHECK_TOKEN: "e2e-healthcheck-token-with-random-characters",
      AI_CREDENTIAL_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      STORAGE_DRIVER: "local",
      UPLOAD_DIR: "/tmp/pheno-lab-e2e-uploads",
      BACKUP_DIR: "/tmp/pheno-lab-e2e-backups",
      APP_VERSION: "e2e",
    },
  },
});
