import path from "node:path";
import { z } from "zod";

const optionalString = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().trim().optional(),
);

const optionalBoolean = z.preprocess((value) => {
  if (value === undefined || value === "") return undefined;
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  return value;
}, z.boolean().optional());

const rawServerConfigSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  APP_VERSION: optionalString,
  DATABASE_URL: z.string().trim().min(1, "DATABASE_URL is required"),
  SESSION_SECRET: z
    .string()
    .min(32, "SESSION_SECRET must contain at least 32 characters"),
  SESSION_COOKIE_SECURE: optionalBoolean,
  INGEST_CRON_SECRET: optionalString.pipe(
    z
      .string()
      .min(24, "INGEST_CRON_SECRET must contain at least 24 characters")
      .optional(),
  ),
  HEALTHCHECK_TOKEN: optionalString.pipe(
    z
      .string()
      .min(24, "HEALTHCHECK_TOKEN must contain at least 24 characters")
      .optional(),
  ),
  AI_CREDENTIAL_KEY: optionalString,
  STORAGE_DRIVER: z.enum(["local", "cos"]).default("local"),
  UPLOAD_DIR: optionalString,
  BACKUP_DIR: optionalString,
  PG_DUMP_BIN: optionalString,
  COS_REGION: optionalString,
  COS_FILES_BUCKET: optionalString,
  COS_AUTH_MODE: z.enum(["instance-role", "static"]).optional(),
  COS_SECRET_ID: optionalString,
  COS_SECRET_KEY: optionalString,
  COS_LEGACY_UPLOAD_DIR: optionalString,
  SMTP_HOST: optionalString,
  SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(465),
  SMTP_USER: optionalString,
  SMTP_PASS: optionalString,
  SMTP_FROM: optionalString,
});

export type ServerConfig = Readonly<
  Omit<
    z.infer<typeof rawServerConfigSchema>,
    "UPLOAD_DIR" | "BACKUP_DIR" | "SESSION_COOKIE_SECURE"
  > & {
    UPLOAD_DIR?: string;
    BACKUP_DIR: string;
    SESSION_COOKIE_SECURE: boolean;
  }
>;

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map(
      (issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`,
    )
    .join("; ");
}

function assertPostgresUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error(
      "DATABASE_URL must use the postgresql:// or postgres:// protocol",
    );
  }
}

function assertProductionSecret(name: string, value: string | undefined): void {
  if (!value) return;
  const normalized = value.toLowerCase();
  if (
    normalized.includes("change-me") ||
    normalized.startsWith("replace-with-") ||
    normalized.includes("example")
  ) {
    throw new Error(`${name} still contains an example value`);
  }
}

function assertAllOrNone(
  config: z.infer<typeof rawServerConfigSchema>,
  names: Array<"SMTP_HOST" | "SMTP_USER" | "SMTP_PASS">,
): void {
  const present = names.filter((name) => Boolean(config[name]));
  if (present.length > 0 && present.length !== names.length) {
    throw new Error(
      `${names.join(", ")} must be configured together or all omitted`,
    );
  }
}

export function parseServerConfig(
  environment: NodeJS.ProcessEnv,
  cwd = process.cwd(),
): ServerConfig {
  const parsed = rawServerConfigSchema.safeParse(environment);
  if (!parsed.success) {
    throw new Error(
      `Invalid server configuration: ${describeIssues(parsed.error)}`,
    );
  }

  const config = parsed.data;
  assertPostgresUrl(config.DATABASE_URL);
  assertAllOrNone(config, ["SMTP_HOST", "SMTP_USER", "SMTP_PASS"]);

  let uploadDir = config.UPLOAD_DIR;
  const backupDir = config.BACKUP_DIR ?? path.join(cwd, "backups");
  if (config.STORAGE_DRIVER === "local") {
    uploadDir ??= path.join(cwd, "uploads");
    if (config.NODE_ENV === "production") {
      if (!path.isAbsolute(uploadDir)) {
        throw new Error("UPLOAD_DIR must be an absolute path in production");
      }
      const releaseRoot = path.resolve(cwd);
      const resolvedUploadDir = path.resolve(
        /* turbopackIgnore: true */ uploadDir,
      );
      if (
        resolvedUploadDir === releaseRoot ||
        resolvedUploadDir.startsWith(`${releaseRoot}${path.sep}`)
      ) {
        throw new Error(
          "UPLOAD_DIR must live outside the immutable release directory",
        );
      }
      if (!config.HEALTHCHECK_TOKEN) {
        throw new Error("HEALTHCHECK_TOKEN is required in production");
      }
    }
  }

  if (config.NODE_ENV === "production") {
    if (!path.isAbsolute(backupDir)) {
      throw new Error("BACKUP_DIR must be an absolute path in production");
    }
    const releaseRoot = path.resolve(cwd);
    const resolvedBackupDir = path.resolve(
      /* turbopackIgnore: true */ backupDir,
    );
    if (
      resolvedBackupDir === releaseRoot ||
      resolvedBackupDir.startsWith(`${releaseRoot}${path.sep}`)
    ) {
      throw new Error(
        "BACKUP_DIR must live outside the immutable release directory",
      );
    }
    assertProductionSecret("SESSION_SECRET", config.SESSION_SECRET);
    assertProductionSecret("INGEST_CRON_SECRET", config.INGEST_CRON_SECRET);
    assertProductionSecret("HEALTHCHECK_TOKEN", config.HEALTHCHECK_TOKEN);
    assertProductionSecret("SMTP_PASS", config.SMTP_PASS);
    if (!config.AI_CREDENTIAL_KEY) {
      throw new Error("AI_CREDENTIAL_KEY is required in production");
    }
  }

  if (
    config.AI_CREDENTIAL_KEY &&
    Buffer.from(config.AI_CREDENTIAL_KEY, "base64").length !== 32
  ) {
    throw new Error("AI_CREDENTIAL_KEY must be a base64-encoded 32-byte key");
  }

  if (config.STORAGE_DRIVER === "cos") {
    if (
      !config.COS_REGION ||
      !config.COS_FILES_BUCKET ||
      !config.COS_AUTH_MODE
    ) {
      throw new Error(
        "COS_REGION, COS_FILES_BUCKET and COS_AUTH_MODE are required when STORAGE_DRIVER=cos",
      );
    }
    if (
      config.COS_AUTH_MODE === "static" &&
      (!config.COS_SECRET_ID || !config.COS_SECRET_KEY)
    ) {
      throw new Error(
        "COS_SECRET_ID and COS_SECRET_KEY are required when COS_AUTH_MODE=static",
      );
    }
    if (config.COS_LEGACY_UPLOAD_DIR && config.NODE_ENV === "production") {
      const legacyDirectory = path.resolve(config.COS_LEGACY_UPLOAD_DIR);
      const releaseRoot = path.resolve(cwd);
      if (!path.isAbsolute(config.COS_LEGACY_UPLOAD_DIR)) {
        throw new Error(
          "COS_LEGACY_UPLOAD_DIR must be an absolute path in production",
        );
      }
      if (
        legacyDirectory === releaseRoot ||
        legacyDirectory.startsWith(`${releaseRoot}${path.sep}`)
      ) {
        throw new Error(
          "COS_LEGACY_UPLOAD_DIR must live outside the immutable release directory",
        );
      }
    }
  }

  return Object.freeze({
    ...config,
    SESSION_COOKIE_SECURE:
      config.SESSION_COOKIE_SECURE ?? config.NODE_ENV === "production",
    UPLOAD_DIR: uploadDir,
    BACKUP_DIR: backupDir,
  });
}
