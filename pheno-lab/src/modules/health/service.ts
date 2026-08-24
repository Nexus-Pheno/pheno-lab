import "server-only";

import crypto from "node:crypto";
import { serverConfig } from "@/infrastructure/config/server";
import { objectStorage } from "@/infrastructure/storage";
import { db } from "@/infrastructure/db/client";

const TIMEOUT_MS = 2_000;
const STORAGE_HEALTH_CACHE_MS = 5_000;
let storageHealthCache:
  | {
      expiresAt: number;
      value: Awaited<ReturnType<ReturnType<typeof objectStorage>["health"]>>;
    }
  | undefined;

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out`)),
          TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function healthRequestId(value: string | null): string {
  return value?.slice(0, 128) || crypto.randomUUID();
}

export function isHealthcheckAuthorized(header: string | null): boolean {
  const config = serverConfig();
  if (config.NODE_ENV !== "production") return true;
  const token = header?.replace(/^Bearer\s+/i, "").trim();
  if (!token || !config.HEALTHCHECK_TOKEN) return false;
  const provided = Buffer.from(token);
  const expected = Buffer.from(config.HEALTHCHECK_TOKEN);
  return (
    provided.length === expected.length &&
    crypto.timingSafeEqual(provided, expected)
  );
}

function basePayload(requestId: string) {
  return {
    service: "pheno-lab",
    timestamp: new Date().toISOString(),
    version: serverConfig().APP_VERSION ?? "unknown",
    requestId,
  };
}

export function livenessPayload(requestId: string) {
  return { ...basePayload(requestId), status: "live" as const };
}

async function storageHealth() {
  if (storageHealthCache && storageHealthCache.expiresAt > Date.now()) {
    return storageHealthCache.value;
  }
  const value = await withTimeout(objectStorage().health(), "storage");
  storageHealthCache = {
    expiresAt: Date.now() + STORAGE_HEALTH_CACHE_MS,
    value,
  };
  return value;
}

export async function readinessPayload(requestId: string) {
  await withTimeout(db.$queryRaw`SELECT 1`, "database");
  const storage = await storageHealth();
  if (!storage.writable) throw new Error("Object storage is not writable.");
  return {
    ...basePayload(requestId),
    status: "ready" as const,
    dependencies: {
      database: "ready" as const,
      storage: "ready" as const,
      storageDriver: storage.driver,
    },
  };
}

export function notReadyPayload(requestId: string) {
  return { ...basePayload(requestId), status: "not-ready" as const };
}
