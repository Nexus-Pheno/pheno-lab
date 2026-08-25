import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseServerConfig } from "./schema";

const base: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://tester:tester@127.0.0.1:5432/pheno_lab_test",
  SESSION_SECRET: "a-secure-test-session-secret-over-32-characters",
  STORAGE_DRIVER: "local",
};

describe("parseServerConfig", () => {
  it("uses a local upload directory during development and test", () => {
    const config = parseServerConfig(base, "/workspace/pheno-lab");
    expect(config.UPLOAD_DIR).toBe(
      path.join("/workspace/pheno-lab", "uploads"),
    );
  });

  it("rejects missing required secrets", () => {
    expect(() =>
      parseServerConfig(
        { ...base, SESSION_SECRET: "short" },
        "/workspace/pheno-lab",
      ),
    ).toThrow(/SESSION_SECRET/);
  });

  it("rejects a non-PostgreSQL database URL", () => {
    expect(() =>
      parseServerConfig({ ...base, DATABASE_URL: "https://example.com/db" }),
    ).toThrow(/postgres/i);
  });

  it("requires an external absolute upload path in production", () => {
    const production: NodeJS.ProcessEnv = {
      ...base,
      NODE_ENV: "production",
      HEALTHCHECK_TOKEN: "health-token-that-is-long-enough-for-production",
    };
    expect(() =>
      parseServerConfig(
        { ...production, UPLOAD_DIR: "uploads" },
        "/srv/pheno-lab/current",
      ),
    ).toThrow(/absolute path/);
    expect(() =>
      parseServerConfig(
        { ...production, UPLOAD_DIR: "/srv/pheno-lab/current/uploads" },
        "/srv/pheno-lab/current",
      ),
    ).toThrow(/outside/);
  });

  it("accepts the first-deployment local storage layout", () => {
    const config = parseServerConfig(
      {
        ...base,
        NODE_ENV: "production",
        UPLOAD_DIR: "/var/lib/pheno-lab/uploads",
        BACKUP_DIR: "/var/lib/pheno-lab/backups",
        SESSION_SECRET: "production-session-secret-with-random-material",
        HEALTHCHECK_TOKEN: "production-healthcheck-token-random-value",
        AI_CREDENTIAL_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      },
      "/srv/pheno-lab/current/pheno-lab",
    );
    expect(config.UPLOAD_DIR).toBe("/var/lib/pheno-lab/uploads");
    expect(config.BACKUP_DIR).toBe("/var/lib/pheno-lab/backups");
    expect(config.SESSION_COOKIE_SECURE).toBe(true);
  });

  it("requires complete COS configuration", () => {
    expect(() => parseServerConfig({ ...base, STORAGE_DRIVER: "cos" })).toThrow(
      /COS_REGION/,
    );
    expect(() =>
      parseServerConfig({
        ...base,
        STORAGE_DRIVER: "cos",
        COS_REGION: "ap-guangzhou",
        COS_FILES_BUCKET: "pheno-lab-prod-files-123456",
        COS_AUTH_MODE: "static",
      }),
    ).toThrow(/COS_SECRET_ID/);
  });

  it("does not require a local backup directory in external backup mode", () => {
    const config = parseServerConfig(
      {
        ...base,
        NODE_ENV: "production",
        STORAGE_DRIVER: "cos",
        COS_REGION: "ap-guangzhou",
        COS_FILES_BUCKET: "pheno-lab-prod-files-123456",
        COS_AUTH_MODE: "instance-role",
        BACKUP_MODE: "external",
        SESSION_SECRET: "production-session-secret-with-random-material",
        HEALTHCHECK_TOKEN: "production-healthcheck-token-random-value",
        AI_CREDENTIAL_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      },
      "/srv/pheno-lab/current/pheno-lab",
    );
    expect(config.BACKUP_MODE).toBe("external");
    expect(config.BACKUP_DIR).toBeUndefined();
  });

  it("allows a read-only legacy directory only outside production releases", () => {
    const cos: NodeJS.ProcessEnv = {
      ...base,
      NODE_ENV: "production",
      STORAGE_DRIVER: "cos",
      COS_REGION: "ap-guangzhou",
      COS_FILES_BUCKET: "pheno-lab-prod-files-123456",
      COS_AUTH_MODE: "instance-role",
      SESSION_SECRET: "production-session-secret-with-random-material",
      HEALTHCHECK_TOKEN: "production-healthcheck-token-random-value",
      AI_CREDENTIAL_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      BACKUP_DIR: "/var/lib/pheno-lab/backups",
    };
    expect(() =>
      parseServerConfig(
        { ...cos, COS_LEGACY_UPLOAD_DIR: "uploads" },
        "/srv/pheno-lab/current/pheno-lab",
      ),
    ).toThrow(/COS_LEGACY_UPLOAD_DIR.*absolute/);
    expect(
      parseServerConfig(
        { ...cos, COS_LEGACY_UPLOAD_DIR: "/var/lib/pheno-lab/uploads" },
        "/srv/pheno-lab/current/pheno-lab",
      ).COS_LEGACY_UPLOAD_DIR,
    ).toBe("/var/lib/pheno-lab/uploads");
  });

  it("requires SMTP settings as a group", () => {
    expect(() =>
      parseServerConfig({ ...base, SMTP_HOST: "smtp.example.com" }),
    ).toThrow(/configured together/);
  });
});
