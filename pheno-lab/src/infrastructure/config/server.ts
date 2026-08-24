import "server-only";

import { parseServerConfig, type ServerConfig } from "./schema";

let cached: ServerConfig | undefined;

export function serverConfig(): ServerConfig {
  cached ??= parseServerConfig(process.env);
  return cached;
}
