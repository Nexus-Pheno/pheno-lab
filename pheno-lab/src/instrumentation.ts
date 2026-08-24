export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { serverConfig } = await import("@/infrastructure/config/server");
  const { log } = await import("@/infrastructure/logging/logger");
  const config = serverConfig();
  log.info("runtime.config_validated", {
    environment: config.NODE_ENV,
    storageDriver: config.STORAGE_DRIVER,
    version: config.APP_VERSION ?? "unknown",
  });
}
